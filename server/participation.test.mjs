import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConnection } from 'mysql2/promise';
import { createPreviewServices } from './api.mjs';
import { openSqliteStore } from './database.mjs';
import { eventId } from './db/migrations.mjs';
import { importSqlite } from './db/import-sqlite.mjs';
import { openMysqlStore } from './db/mysql.mjs';
import { catRequirement, mileagePoints, sessionWindow } from './rules.mjs';
import { scheduleSettlements } from './settlements.mjs';

const day = '2026-11-23';
const morning = sessionWindow(day, 'morning');
const evening = sessionWindow(day, 'evening');
const point = { lat: 34.17942, lng: 108.91808, accuracy: 10 };
const step = { ...point, lat: point.lat + 0.00019 };
const mysqlUrl = process.env.MYSQL_TEST_URL;

test('P0-5a pace limits and integer mileage tiers are cumulative', () => {
  assert.deepEqual(catRequirement('morning', 'male'), { meters: 2000, seconds: 1020 });
  assert.deepEqual(catRequirement('morning', 'female'), { meters: 2000, seconds: 1200 });
  assert.deepEqual(catRequirement('evening', 'male'), { meters: 3000, seconds: 1530 });
  assert.deepEqual(catRequirement('evening', 'female'), { meters: 3000, seconds: 1800 });
  assert.deepEqual([1999, 2000, 7999, 8000, 9999, 10000].map((m) => mileagePoints('cat', m)),
    [0, 1, 1, 4, 4, 14]);
  assert.deepEqual([2999, 3000, 8999, 9000, 9999, 10000].map((m) => mileagePoints('mouse', m)),
    [0, 1, 1, 4, 4, 14]);
});

async function exercise(t, open) {
  let now = morning.startsAt;
  const clock = () => now;
  let store = await open();
  let app = createPreviewServices(store, clock);
  t.after(() => app.close());
  const { users, ledger } = store.tables;

  async function player(role, stage, gender = 'male') {
    const id = randomUUID();
    await store.transaction((tx) => tx.run(`INSERT INTO ${users}
      (id, nickname, role, stage, openid, gender, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, role, role, stage, `test-${id}`, gender, now));
    return app.game.getPlayer(id);
  }
  const entry = (who, session) => store.read((tx) => tx.get(
    'SELECT * FROM participation_sessions WHERE event_id = ? AND session_id = ? AND player_id = ?',
    eventId, session.id, who.id));
  const grants = (who, session) => store.read(async (tx) => (await tx.all(
    `SELECT source, amount FROM ${ledger} WHERE player_id = ? AND session_id = ? ORDER BY source`, who.id, session.id))
    .map((row) => ({ ...row })));
  const historic = (who, session, meters, overrides = {}) => store.transaction((tx) => tx.run(`
    UPDATE participation_sessions SET valid_meters = ?, paused_total_seconds = ?, last_sample_at = ?,
      anchor_lat = ?, anchor_lng = ? WHERE event_id = ? AND session_id = ? AND player_id = ?`,
  meters, overrides.pause ?? 0, overrides.lastSample ?? session.endsAt - 5000, point.lat, point.lng,
  eventId, session.id, who.id));
  const sample = (who, at, session = morning, coordinates = point, gap) => {
    now = at;
    return app.positions.save(who.id, coordinates, undefined, session.id, gap);
  };

  const timers = [];
  const schedule = () => scheduleSettlements(app.game.settleDue, {
    clock,
    setTimer(run, delay) { const timer = { at: now + delay, run }; timers.push(timer); return timer; },
    clearTimer(timer) { if (timers.includes(timer)) timers.splice(timers.indexOf(timer), 1); },
    onError: t.assert.fail,
  });
  async function tick(at) {
    const timer = timers.shift();
    assert.equal(timer.at, at);
    now = at;
    await timer.run();
  }
  const jobs = schedule();
  t.after(() => jobs.stop());
  await jobs.ready;

  const uncategorized = await player('cat', 'morning', 'unknown');
  await assert.rejects(app.game.setTracking(uncategorized, true, morning.id), { code: 'GENDER' });
  await assert.rejects(app.game.move(uncategorized, randomUUID()), { code: 'DEMO_ONLY' });
  const valid = await player('cat', 'morning');
  const late = await player('cat', 'morning');
  const cat = await player('cat', 'morning', 'female');
  for (const who of [valid, late, cat]) await app.game.setTracking(who, true, morning.id);
  const started = now;
  assert.equal((await app.game.snapshot(cat)).stats.meters, 0);

  await sample(cat, started);
  for (let n = 1; n <= 5; n++) await sample(cat, started + 5000 * n, morning, n % 2 ? step : point);
  assert.ok((await entry(cat, morning)).valid_meters >= 100);
  const mouse = await player('mouse', 'morning');
  await app.positions.save(mouse.id, step);
  const code = await app.game.issueCode(mouse, null, 'mouse');
  assert.equal((await app.game.capture(cat, randomUUID(), code.code)).award, 10);
  await store.transaction((tx) => tx.addPoints(randomUUID(), cat.id, 'morning', 'redemption', -8, now, morning.id));

  const distanceBeforeGap = (await entry(cat, morning)).valid_meters;
  await app.game.dataGap(cat, morning.id, 'hidden');
  assert.equal((await app.game.snapshot(cat)).participation.dataGap, true);
  await sample(cat, now + 20_000);
  assert.equal((await entry(cat, morning)).valid_meters, distanceBeforeGap);
  // Covers a WebView that suspended the hide request before it could be posted.
  await sample(cat, now + 5000, morning, step, 'hidden');
  assert.equal((await entry(cat, morning)).valid_meters, distanceBeforeGap);
  // No client event is required when consecutive fixes are too far apart in time.
  await sample(cat, now + 40_000);
  assert.equal((await entry(cat, morning)).valid_meters, distanceBeforeGap);
  await sample(cat, now + 5000, morning, { ...step, accuracy: 81 });
  assert.equal((await entry(cat, morning)).valid_meters, distanceBeforeGap);
  await sample(cat, now + 5000);
  await sample(cat, now + 1000, morning, step);
  assert.equal((await entry(cat, morning)).valid_meters, distanceBeforeGap);

  await app.game.setTracking(cat, false, morning.id);
  assert.equal(await sample(cat, now + 30_000, morning, step), undefined);
  await app.game.exitParticipation(cat, morning.id);
  assert.equal((await entry(cat, morning)).status, 'exited');
  assert.equal(await sample(cat, now + 60_000, morning, step), undefined);
  await app.game.setTracking(cat, true, morning.id);
  assert.equal((await entry(cat, morning)).started_at, started);
  assert.equal((await entry(cat, morning)).paused_total_seconds, 90);
  assert.equal(await sample(cat, now + 1000, evening, step), undefined);

  const deadline = morning.startsAt + 1020_000;
  for (const who of [valid, late]) {
    await historic(who, morning, 1980, { lastSample: deadline - 5000 });
    await sample(who, deadline + Number(who === late), morning, step);
  }
  assert.equal((await entry(valid, morning)).completed_at, deadline);
  assert.equal((await entry(late, morning)).completed_at, deadline + 1);
  await historic(valid, morning, 10_000);
  await historic(late, morning, 10_000);
  assert.equal(await app.game.settleDue(morning.endsAt - 1), 0);
  await tick(morning.endsAt);
  assert.equal((await entry(valid, morning)).status, 'settled');
  assert.equal((await entry(late, morning)).status, 'void');
  assert.deepEqual(await grants(valid, morning), [{ source: 'mileage', amount: 14 }]);
  assert.deepEqual(await grants(late, morning), []);
  assert.equal((await entry(cat, morning)).status, 'void');
  const invalid = await app.game.snapshot(cat);
  assert.equal(invalid.stats.meters, 0);
  assert.equal(invalid.stats.balance, -8);
  assert.equal(invalid.stats.availablePoints, 0);
  assert.equal(invalid.stats.sessionPoints, 0);
  assert.equal(invalid.captures[0].voided, true);
  assert.deepEqual(await grants(cat, morning), [
    { source: 'capture', amount: 10 }, { source: 'capture_reversal', amount: -10 },
    { source: 'redemption', amount: -8 },
  ]);
  const audit = await store.read((tx) => tx.all(
    'SELECT action, details FROM audit_logs WHERE entity_id = ? ORDER BY id', `${morning.id}/${cat.id}`));
  const details = (row) => typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
  assert.ok(audit.some((row) => row.action === 'data_gap' && details(row).reason === 'hidden' && details(row).reviewable));
  assert.ok(audit.some((row) => row.action === 'data_gap' && details(row).reason === 'timeout'));
  assert.ok(audit.some((row) => row.action === 'session_void' && details(row).captureReversal === 10));
  assert.equal((await app.game.leaderboard(cat, 'day')).find((row) => row.mine).captures, 0);

  now = evening.startsAt;
  const full = await player('mouse', 'evening', 'female');
  const short = await player('mouse', 'evening', 'female');
  const gapped = await player('mouse', 'evening', 'female');
  const capped = await player('mouse', 'evening', 'female');
  for (const who of [full, short, gapped, capped]) await app.game.setTracking(who, true, evening.id);
  const hiddenAt = evening.endsAt - 16 * 60_000;
  const pausedAt = evening.endsAt - 15 * 60_000;
  await historic(full, evening, 10_000, { pause: 899.999 });
  await historic(short, evening, 10_000, { lastSample: pausedAt });
  await historic(gapped, evening, 10_000, { pause: 899.999, lastSample: hiddenAt });
  await historic(capped, evening, 10_000);
  await store.transaction((tx) => tx.addPoints(randomUUID(), capped.id, 'evening', 'bonus', 119, now, evening.id));
  now = hiddenAt;
  await app.game.dataGap(gapped, evening.id, 'hidden');
  now = pausedAt;
  await app.game.setTracking(short, false, evening.id);
  await tick(evening.endsAt);
  assert.deepEqual(await grants(full, evening), [{ source: 'mileage', amount: 14 }, { source: 'mouse_attendance', amount: 100 }]);
  assert.deepEqual(await grants(short, evening), [{ source: 'mileage', amount: 14 }]);
  assert.deepEqual(await grants(gapped, evening),
    [{ source: 'mileage', amount: 14 }, { source: 'mouse_attendance', amount: 100 }]);
  const mouseGap = await store.read((tx) => tx.get(
    "SELECT details FROM audit_logs WHERE entity_id = ? AND action = 'data_gap'", `${evening.id}/${gapped.id}`));
  assert.deepEqual(details(mouseGap), { reason: 'hidden', startedAt: hiddenAt, endedAt: evening.endsAt, reviewable: true });
  assert.deepEqual(await grants(capped, evening), [{ source: 'bonus', amount: 119 }, { source: 'mouse_attendance', amount: 1 }]);
  await jobs.stop();

  const missed = sessionWindow('2026-11-24', 'morning');
  now = missed.startsAt;
  const returning = await app.game.updatePlayer(cat, { stage: 'morning' });
  assert.equal(returning.stats.dailyPoints, 0);
  await app.game.setTracking(cat, true, missed.id);
  const requirement = (await entry(cat, missed)).max_seconds;
  const deadline2 = missed.startsAt + requirement * 1000;
  await historic(cat, missed, 9980, { lastSample: deadline2 - 5000 });
  await sample(cat, deadline2, missed, step);
  await app.close();
  store = await open();
  app = createPreviewServices(store, clock);
  now = evening.endsAt + 36 * 3600_000;
  const peerStore = await open();
  const peer = createPreviewServices(peerStore, clock);
  try {
    const restarted = schedule();
    try {
      await Promise.all([restarted.ready, peer.game.settleDue()]);
      assert.deepEqual(await grants(cat, missed), [{ source: 'mileage', amount: 14 }]);
      assert.equal((await app.game.snapshot(cat)).stats.balance, 6);
      assert.equal(await peer.game.settleDue(), 0);
    } finally {
      await restarted.stop();
    }
  } finally {
    await peer.close();
  }
}

test('P0-5a tracking and settlements with SQLite', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'campus-participation-test-'));
  const file = join(dir, 'test.sqlite3');
  try {
    await exercise(t, () => openSqliteStore(file));
  } finally {
    // The final store close is registered by exercise.
    t.after(() => rmSync(dir, { recursive: true, force: true }));
  }
});

async function disposableMysql() {
  const url = new URL(mysqlUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const dbName = `campus_participation_${randomUUID().replaceAll('-', '')}`;
  url.pathname = '/';
  const admin = await createConnection(url.href);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  url.pathname = `/${dbName}`;
  const close = async () => {
    await admin.query(`DROP DATABASE \`${dbName}\``);
    await admin.end();
  };
  return { open: () => openMysqlStore(url.href), close };
}

test('P0-5a tracking and settlements with MySQL 8', { skip: !mysqlUrl, timeout: 60_000 }, async (t) => {
  const database = await disposableMysql();
  try {
    await exercise(t, database.open);
  } finally {
    t.after(database.close);
  }
});

test('SQLite import preserves settlement keys, original ledger sessions and review data', { skip: !mysqlUrl }, async (t) => {
  const database = await disposableMysql();
  const dir = mkdtempSync(join(tmpdir(), 'campus-participation-import-'));
  const file = join(dir, 'snapshot.sqlite3');
  const source = openSqliteStore(file);
  let target;
  t.after(async () => {
    await source.close();
    await target?.close();
    await database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let now = morning.startsAt;
  const { game } = createPreviewServices(source, () => now);
  await source.transaction(async (tx) => {
    await tx.run(`INSERT INTO players (id, nickname, stage, created_at, openid, gender)
      VALUES ('import-cat', 'Test cat', 'morning', ?, 'import-cat', 'male')`, now);
  });
  const cat = await game.getPlayer('import-cat');
  await game.setTracking(cat, true, morning.id);
  await game.dataGap(cat, morning.id, 'hidden');
  await source.transaction(async (tx) => {
    await tx.addPoints('fixture-capture', cat.id, 'morning', 'capture', 10, now, morning.id);
    await tx.addPoints('fixture-spend', cat.id, 'morning', 'redemption', -8, now, morning.id);
  });
  now += 86_400_000;
  await game.settleDue();
  await source.close();
  target = await database.open();
  const inserted = await importSqlite(file, target);
  assert.equal(inserted.participation_sessions, 1);
  assert.equal(inserted.session_settlements, 1);
  assert.equal(inserted.audit_logs, 2);
  const imported = createPreviewServices(target, () => now);
  assert.equal((await imported.game.getPlayer(cat.id)).gender, 'male');
  assert.equal((await imported.game.snapshot(cat)).stats.balance, -8);
  assert.equal(await imported.game.settleDue(), 0);
  const reversal = await target.read((tx) => tx.get("SELECT session_id FROM points_ledger WHERE source = 'capture_reversal'"));
  assert.equal(reversal.session_id, morning.id);
  const replay = await importSqlite(file, target);
  assert.equal(replay.audit_logs, 0);
  assert.equal(replay.points_ledger, 0);
});
