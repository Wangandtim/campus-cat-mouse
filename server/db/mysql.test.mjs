import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createConnection } from 'mysql2/promise';
import { io as connect } from 'socket.io-client';
import { createPreviewApi, createPreviewServices } from '../api.mjs';
import { attachLivePositions } from '../live/positions.mjs';
import { importSqlite } from './import-sqlite.mjs';
import { eventId } from './migrations.mjs';
import { openMysqlStore } from './mysql.mjs';

const url = process.env.MYSQL_TEST_URL;
const point = { lat: 34.17942, lng: 108.91808, accuracy: 13 };
const evening = Date.parse('2026-11-23T17:45:00+08:00');
const account = (store, player) => store.read((db) => db.get(
  'SELECT balance, version FROM points_accounts WHERE player_id = ?', player.id,
));

function gameAt(store, start) {
  let time = start;
  const clock = () => time;
  const { game, liveGame, positions } = createPreviewServices(store, clock);
  const locate = (first, second) => Promise.all([positions.save(first.id, point), positions.save(second.id, point)]);
  const issue = async (mouse) => (await game.issueCode(mouse, null, 'mouse')).code;
  return {
    game, liveGame, positions, clock, locate, issue,
    advance(ms) { time += ms; },
    setTime(now) { time = now; },
    async pair() {
      const cat = await game.join();
      const mouse = await game.join();
      await game.snapshot(cat);
      await game.updatePlayer(mouse, { role: 'mouse' });
      await locate(cat, mouse);
      return { cat, mouse, code: await issue(mouse), key: randomUUID() };
    },
  };
}

async function runHttp(t, app) {
  const { game, liveGame, positions, clock } = app;
  const server = createServer((req, res) => void api(req, res));
  const { io, profileChanged } = attachLivePositions(server, { game: liveGame, positions, clock });
  const api = createPreviewApi({}, game, positions, profileChanged);
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await io.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `http://127.0.0.1:${server.address().port}`;
  const cookie = (player) => `campus_demo=${player.id}`;
  return {
    async capture({ cat, code, key }) {
      const response = await fetch(`${host}/api/preview/capture`, {
        method: 'POST',
        headers: { Cookie: cookie(cat), 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ code }),
      });
      return { status: response.status, body: await response.json() };
    },
    async socket(player) {
      const socket = connect(host, { autoConnect: false, forceNew: true, transports: ['websocket'],
        extraHeaders: { Cookie: cookie(player) } });
      sockets.push(socket);
      const ready = once(socket, 'live:ready', { signal: AbortSignal.timeout(5000) });
      socket.connect();
      assert.equal((await ready)[0].eventId, '2026-11-23:evening');
      return socket;
    },
  };
}

test('P0-1b with a disposable MySQL 8 schema', { skip: !url, timeout: 60000 }, async (t) => {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const store = await openMysqlStore(url);
  t.after(store.close);

  await t.test('imports legacy history once, rebuilds balances, and rolls back a unique conflict', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-import-test-'));
    const filename = join(dir, 'snapshot.sqlite3');
    const legacy = new DatabaseSync(filename);
    t.after(() => {
      legacy.close();
      rmSync(filename, { force: true });
      rmdirSync(dir);
    });
    legacy.exec(`
      CREATE TABLE players (id TEXT, nickname TEXT, role TEXT, stage TEXT, sharing INTEGER, created_at INTEGER);
      INSERT INTO players VALUES ('legacy-cat','cat','cat','evening',1,${evening}),
        ('legacy-mouse','mouse','mouse','evening',1,${evening});
      CREATE TABLE positions (user_id TEXT, role TEXT, lat REAL, lng REAL, accuracy REAL, updated_at INTEGER, session_id TEXT);
      INSERT INTO positions VALUES ('legacy-cat','cat',34,108,13,${evening},NULL),
        ('legacy-mouse','mouse',34,108,13,${evening},'2026-11-23:evening');
      CREATE TABLE captures (id TEXT, player_id TEXT, stage TEXT, mouse_id INTEGER, zone_id TEXT,
        completed_at INTEGER, meters INTEGER, awarded INTEGER);
      INSERT INTO captures VALUES ('old-capture','legacy-cat','evening',3,'zone',${evening},1280,10);
      CREATE TABLE points (id TEXT, player_id TEXT, stage TEXT, source TEXT, amount INTEGER, created_at INTEGER);
      INSERT INTO points VALUES ('old-capture','legacy-cat','evening','capture',10,${evening}),
        ('old-consumption','legacy-cat','evening','spend',-4,${evening}),
        ('old-distance','legacy-cat','evening','distance',12,${evening});
    `);
    const report = await importSqlite(filename, store);
    assert.equal(report.skippedPositions, 1);
    assert.equal(report.positions, 1);
    assert.equal(report.captures, 1);
    assert.equal(report.points_ledger, 3);
    assert.deepEqual(await store.read((db) => db.get(`SELECT event_id, session_id, legacy_mouse_number
      FROM captures WHERE id = 'old-capture'`)), { event_id: eventId, session_id: null, legacy_mouse_number: 3 });
    const before = await account(store, { id: 'legacy-cat' });
    assert.equal(before.balance, 18);
    assert.equal((await store.read((db) => db.get("SELECT balance FROM points_session_accounts WHERE player_id = 'legacy-cat'"))).balance, 18);
    const repeat = await importSqlite(filename, store);
    assert.equal(repeat.points_ledger, 0);
    assert.equal(repeat.captures, 0);
    assert.deepEqual(await account(store, { id: 'legacy-cat' }), before);

    legacy.exec(`INSERT INTO players VALUES ('rolled-back-user','cat','cat','evening',1,${evening});
      INSERT INTO captures SELECT 'z-conflict', player_id, stage, mouse_id, zone_id,
        completed_at, meters, awarded FROM captures WHERE id = 'old-capture'`);
    await assert.rejects(importSqlite(filename, store), { code: 'SQLITE_IMPORT_CONFLICT', message: /captures_by_sample/ });
    assert.equal(await store.read((db) => db.get("SELECT id FROM users WHERE id = 'rolled-back-user'")), undefined);
    assert.deepEqual(await account(store, { id: 'legacy-cat' }), before);
    await assert.rejects(store.transaction((db) => db.run("UPDATE points_ledger SET amount = 99 WHERE id = 'old-capture'")),
      { code: 'ER_SIGNAL_EXCEPTION' });
  });

  await t.test('concurrent HTTP requests replay a single action and Socket.IO saves to MySQL', async (t) => {
    const app = gameAt(store, evening);
    const pair = await app.pair();
    const initial = await account(store, pair.cat);
    const http = await runHttp(t, app);
    const catSocket = await http.socket(pair.cat);
    const mouseSocket = await http.socket(pair.mouse);
    const changedPoint = { ...point, lat: point.lat + 0.00001 };
    const snapshot = once(catSocket, 'live:positions', { signal: AbortSignal.timeout(8000) });
    mouseSocket.emit('live:position', changedPoint);
    const [, markers] = await snapshot;
    assert.equal(markers[0].lat, changedPoint.lat);
    assert.equal((await app.positions.get(pair.mouse.id)).lat, changedPoint.lat);

    const concurrent = await Promise.all([http.capture(pair), http.capture(pair)]);
    assert.equal(concurrent[0].status, 200);
    assert.deepEqual(concurrent[1], concurrent[0]);
    assert.equal(concurrent[0].body.award, 10);
    assert.deepEqual(await account(store, pair.cat), { balance: initial.balance + 10, version: initial.version + 1 });
    const recorded = await store.read((db) => db.get('SELECT result FROM actions WHERE player_id = ? AND request_id = ?', pair.cat.id, pair.key));
    assert.deepEqual(JSON.parse(recorded.result), concurrent[0].body);
    assert.equal((await store.read((db) => db.get('SELECT COUNT(*) AS n FROM captures WHERE player_id = ?', pair.cat.id))).n, 1);
    assert.equal((await store.read((db) => db.get("SELECT COUNT(*) AS n FROM points_ledger WHERE player_id = ? AND source = 'capture'", pair.cat.id))).n, 1);
    assert.equal((await http.capture({ ...pair, key: randomUUID() })).body.code, 'SESSION_DUP');

    app.setTime(Date.parse('2026-11-24T06:35:00+08:00'));
    await app.game.updatePlayer(pair.cat, { stage: 'morning' });
    await app.game.updatePlayer(pair.mouse, { stage: 'morning' });
    await app.locate(pair.cat, pair.mouse);
    const nextCode = await app.issue(pair.mouse);
    const competing = await Promise.allSettled(Array.from({ length: 2 }, () => app.game.capture(pair.cat, randomUUID(), nextCode)));
    assert.equal(competing.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(competing.find((attempt) => attempt.status === 'fulfilled').value.award, 10);
    assert.equal(competing.find((attempt) => attempt.status === 'rejected').reason.code, 'SESSION_DUP');

    const otherMouse = await app.game.join();
    await app.game.updatePlayer(otherMouse, { role: 'mouse', stage: 'morning' });
    await app.game.setTracking(pair.cat, true);
    await app.game.move(pair.cat, randomUUID());
    await app.locate(pair.cat, otherMouse);
    const secondMouse = await app.game.capture(pair.cat, randomUUID(), await app.issue(otherMouse));
    assert.equal(secondMouse.mouseId, competing.find((attempt) => attempt.status === 'fulfilled').value.mouseId);
  });

  await t.test('the fifth concurrent capture owns the only cooldown and the sixth can retry after expiry', async () => {
    const app = gameAt(store, evening + 2 * 86_400_000);
    const pairs = await Promise.all(Array.from({ length: 6 }, () => app.pair()));
    const results = await Promise.allSettled(pairs.map((pair) => app.game.capture(pair.cat, pair.key, pair.code)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
    const failed = results.findIndex((result) => result.status === 'rejected');
    assert.equal(results[failed].reason.code, 'LOCK');
    const locked = await store.read((db) => db.all(`SELECT grid_lock_until FROM captures
      WHERE event_id = ? AND session_id = '2026-11-25:evening' AND grid_lock_until IS NOT NULL`, eventId));
    assert.deepEqual(locked, [{ grid_lock_until: app.clock() + 30_000 }]);
    const pair = pairs[failed];
    app.advance(30_000);
    await app.locate(pair.cat, pair.mouse);
    assert.equal((await app.game.capture(pair.cat, pair.key, await app.issue(pair.mouse))).award, 10);
  });

  await t.test('a rejected ledger write rolls back capture, account versions, and the action claim', async () => {
    const app = gameAt(store, evening + 3 * 86_400_000);
    const { cat, code, key } = await app.pair();
    const before = await account(store, cat);
    const sessionAccount = () => store.read((db) => db.get('SELECT balance, version FROM points_session_accounts WHERE player_id = ?', cat.id));
    const beforeSession = await sessionAccount();
    const fault = await createConnection(url);
    try {
      await fault.query(`CREATE TRIGGER test_reject_ledger BEFORE INSERT ON points_ledger FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test rollback'`);
      try {
        await assert.rejects(app.game.capture(cat, key, code), { code: 'ER_SIGNAL_EXCEPTION' });
      } finally {
        await fault.query('DROP TRIGGER test_reject_ledger');
      }
    } finally {
      await fault.end();
    }
    assert.deepEqual(await account(store, cat), before);
    assert.deepEqual(await sessionAccount(), beforeSession);
    assert.equal((await store.read((db) => db.get('SELECT COUNT(*) AS n FROM captures WHERE player_id = ?', cat.id))).n, 0);
    assert.equal(await store.read((db) => db.get('SELECT result FROM actions WHERE player_id = ? AND request_id = ?', cat.id, key)), undefined);
    assert.equal((await app.game.capture(cat, key, code)).award, 10);
    await store.transaction(async (tx) => {
      await tx.lockPlayers([cat.id]);
      await tx.addPoints(randomUUID(), cat.id, cat.stage, 'spend', -5, app.clock());
    });
    assert.equal((await account(store, cat)).balance, before.balance + 5);
    assert.equal((await app.game.snapshot(cat)).stats.sessionPoints, before.balance + 10);
  });

  await t.test('retries a deadlock and stops after the third lock-timeout retry', async () => {
    const session = '2026-11-27:evening';
    await store.transaction((tx) => tx.ensureSession(session));
    const barrier = Promise.withResolvers();
    const attempts = [0, 0];
    let firstLocks = 0;
    const cross = (index) => store.transaction(async (tx) => {
      const attempt = ++attempts[index];
      await tx.lockGrid(session, `deadlock-${index}`);
      if (attempt === 1) {
        if (++firstLocks === 2) barrier.resolve();
        await barrier.promise;
      }
      await tx.lockGrid(session, `deadlock-${1 - index}`);
    });
    await Promise.all([cross(0), cross(1)]);
    assert.equal(attempts[0] + attempts[1], 3);

    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    const held = store.transaction(async (tx) => {
      await tx.lockGrid(session, 'timeout');
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    let tries = 0;
    const request = randomUUID();
    try {
      await assert.rejects(store.transaction(async (tx) => {
        tries++;
        await tx.run('SET SESSION innodb_lock_wait_timeout = 1');
        await tx.claimAction('timeout-probe', request, 'capture');
        await tx.lockGrid(session, 'timeout');
      }), { errno: 1205 });
    } finally {
      release.resolve();
      await held;
    }
    assert.equal(tries, 4);
    assert.equal(await store.read((db) => db.get('SELECT result FROM actions WHERE player_id = ? AND request_id = ?', 'timeout-probe', request)), undefined);
  });
});
