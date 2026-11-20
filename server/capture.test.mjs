import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import campus from '../src/data/campus.json' with { type: 'json' };
import { createPreviewApi, openPreview } from './api.mjs';

const evening = Date.parse('2026-11-23T17:45:00+08:00');
const morning = Date.parse('2026-11-24T06:35:00+08:00');
const point = { lng: 108.91808, lat: 34.17942, accuracy: 13 };
const nextGrid = { ...point, lat: point.lat + 0.00056 };

function accepted({ status, data }) {
  assert.equal(status, 200, JSON.stringify(data));
  return data;
}

function rejected({ status, data }, code) {
  assert.equal(status, 409, JSON.stringify(data));
  assert.equal(data.code, code);
}

async function preview(t, { time = evening, seed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'campus-capture-test-'));
  const filename = join(dir, 'test.sqlite3');
  let app;
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await app?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
    rmdirSync(dir);
  });
  seed?.(filename, time);
  app = openPreview(filename, undefined, () => time);
  server = createServer(createPreviewApi({}, app.game, app.positions));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function request(path, cookie, body, key) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const res = await fetch(`${origin}/api/preview/${path}`, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json(), cookie: res.headers.getSetCookie()[0]?.split(';')[0] };
  }

  function player(cookie) {
    return {
      get: async (path) => accepted(await request(path, cookie)),
      post: async (path, body = {}, key) => accepted(await request(path, cookie, body, key)),
      capture: (code, key = randomUUID(), fields = {}) => request('capture', cookie, { ...fields, code }, key),
    };
  }

  return {
    player,
    async join(profile) {
      const registered = await request('state');
      accepted(registered);
      const joined = player(registered.cookie);
      if (profile) await joined.post('profile', profile);
      return joined;
    },
    advance(ms) { time += ms; },
    setTime(at) { time = at; },
  };
}

const issue = async (mouse) => (await mouse.post('mouse-code')).code;

async function reportPair(cat, mouse, coordinates = point) {
  await cat.post('position', coordinates);
  await mouse.post('position', coordinates);
}

test('capture reads both saved positions and compares unrounded distance', async (t) => {
  const app = await preview(t);
  const cat = await app.join();
  const mouse = await app.join({ role: 'mouse' });
  const code = await issue(mouse);
  const key = randomUUID();
  rejected(await cat.capture(code, key, point), 'ACCURACY');

  await cat.post('position', point);
  await mouse.post('position', { ...point, lat: point.lat + 0.000271 }); // About 30.13 m.
  rejected(await cat.capture(code, key, { ...point, catPosition: point, mousePosition: point }), 'DISTANCE');
  assert.equal((await cat.get('state')).stats.captures, 0);

  await mouse.post('position', { ...point, lat: point.lat + 0.0002696 }); // Just under 30 m.
  const capture = accepted(await cat.capture(code, key, { lat: 0, lng: 0, accuracy: 999 }));
  assert.equal(capture.award, 10);
  assert.equal((await cat.get('state')).stats.captures, 1);
});

test('checks accuracy and campus boundary on each side of the capture', async (t) => {
  const app = await preview(t);
  const cat = await app.join();
  const mouse = await app.join({ role: 'mouse' });
  const code = await issue(mouse);
  const inside = { lng: 108.91415, lat: 34.18, accuracy: 50 };
  for (const player of [cat, mouse]) {
    await reportPair(cat, mouse, inside);
    await player.post('position', { ...inside, accuracy: 50.01 });
    rejected(await cat.capture(code), 'ACCURACY');
    await player.post('position', { ...inside, lng: 108.91400 });
    rejected(await cat.capture(code), 'FENCE');
  }
  const [lng, lat] = campus.boundary[0];
  await reportPair(cat, mouse, { lng, lat, accuracy: 50 });
  assert.equal(accepted(await cat.capture(code)).award, 10);
});

test('requires a server-assigned session and a position no more than 30 seconds old', async (t) => {
  const app = await preview(t);
  const cat = await app.join();
  const mouse = await app.join({ role: 'mouse', stage: 'morning' });
  const saved = await mouse.post('position', { ...point, session_id: '2026-11-23:evening', updated_at: 0 });
  assert.equal(saved.session_id, '2026-11-23:morning');
  assert.equal(saved.updated_at, evening);
  assert.deepEqual(await mouse.get('position'), saved);
  await mouse.post('profile', { stage: 'evening' });
  await cat.post('position', point);
  rejected(await cat.capture(await issue(mouse)), 'SESSION');

  app.advance(30_001);
  await mouse.post('position', point);
  rejected(await cat.capture(await issue(mouse)), 'ACCURACY');
  await cat.post('position', point);
  app.advance(30_000);
  assert.equal(accepted(await cat.capture(await issue(mouse))).award, 10);
});

test('only accepts real scans and position timestamps during the active Shanghai window', async (t) => {
  const start = Date.parse('2026-11-23T17:30:00+08:00');
  const app = await preview(t, { time: start - 1000 });
  const cat = await app.join();
  const mouse = await app.join({ role: 'mouse' });
  await reportPair(cat, mouse);
  const code = await issue(mouse);
  rejected(await cat.capture(code), 'SESSION');
  app.setTime(start);
  rejected(await cat.capture(code), 'SESSION');
  await reportPair(cat, mouse);
  assert.equal(accepted(await cat.capture(code)).award, 10);
  app.setTime(Date.parse('2026-11-23T20:30:00+08:00'));
  await reportPair(cat, mouse);
  rejected(await cat.capture(await issue(mouse)), 'SESSION');
});

test('deduplicates by actual mouse and session, keeps stamina, and replays a single award', async (t) => {
  const app = await preview(t);
  const cat = await app.join();
  const otherCat = await app.join();
  const mouse = await app.join({ role: 'mouse' });
  const otherMouse = await app.join({ role: 'mouse' });
  await reportPair(cat, mouse);
  const code = await issue(mouse);
  const key = randomUUID();
  const results = await Promise.all([cat.capture(code, key), cat.capture(code, key)]);
  const first = accepted(results[0]);
  assert.deepEqual(accepted(results[1]), first);
  assert.equal((await cat.get('state')).stats.sessionPoints, 22);
  await otherCat.post('position', point);
  rejected(await otherCat.capture(code), 'TOKEN');
  rejected(await cat.capture(await issue(mouse)), 'SESSION_DUP');

  await otherMouse.post('position', point);
  const otherCode = await issue(otherMouse);
  rejected(await cat.capture(otherCode), 'STAMINA');
  await cat.post('tracking', { active: true });
  const walk = await cat.post('move', {}, randomUUID());
  assert.equal(walk.meters, 1380);
  assert.equal(accepted(await cat.capture(otherCode)).award, 10);

  app.setTime(morning);
  await cat.post('profile', { stage: 'morning' });
  await mouse.post('profile', { stage: 'morning' });
  await reportPair(cat, mouse);
  assert.equal(accepted(await cat.capture(await issue(mouse))).award, 10);
  assert.deepEqual(accepted(await cat.capture(code, key)), first);

  app.setTime(evening + 24 * 60 * 60_000);
  await cat.post('profile', { stage: 'evening' });
  await mouse.post('profile', { stage: 'evening' });
  await cat.post('move', {}, randomUUID());
  await reportPair(cat, mouse);
  assert.equal(accepted(await cat.capture(await issue(mouse))).award, 10);
});

test('five successes lock the mouse grid for 30 seconds across cats and mice', async (t) => {
  const app = await preview(t);
  const mouse = await app.join({ role: 'mouse' });
  const otherMouse = await app.join({ role: 'mouse' });
  for (let index = 0; index < 5; index++) {
    const cat = await app.join();
    if (index === 4) app.advance(10_000);
    await reportPair(cat, mouse);
    assert.equal(accepted(await cat.capture(await issue(mouse))).award, 10);
  }

  app.advance(29_999);
  const cat = await app.join();
  await reportPair(cat, otherMouse);
  const code = await issue(otherMouse);
  rejected(await cat.capture(code), 'LOCK');
  await reportPair(cat, otherMouse, nextGrid);
  assert.equal(accepted(await cat.capture(code)).award, 10);

  app.advance(1);
  const nextCat = await app.join();
  await reportPair(nextCat, mouse);
  assert.equal(accepted(await nextCat.capture(await issue(mouse))).award, 10);
});

test('live capture awards keep the 100-point session and 200-point daily caps', async (t) => {
  const firstMorning = morning - 24 * 60 * 60_000;
  const app = await preview(t, { time: firstMorning });
  const cat = await app.join();
  const mice = await Promise.all(Array.from({ length: 10 }, () => app.join({ role: 'mouse' })));
  for (const [stage, time] of [['morning', firstMorning], ['evening', evening]]) {
    app.setTime(time);
    await cat.post('profile', { stage });
    await cat.post('tracking', { active: true });
    const awards = [];
    for (const [index, mouse] of mice.entries()) {
      await mouse.post('profile', { stage });
      await reportPair(cat, mouse, index < 5 ? point : nextGrid);
      const code = await issue(mouse);
      if (index === 0 && stage === 'evening') rejected(await cat.capture(code), 'STAMINA');
      await cat.post('move', {}, randomUUID());
      awards.push(accepted(await cat.capture(code)).award);
    }
    const { stats } = await cat.get('state');
    assert.equal(stats.sessionPoints, 100);
    assert.equal(stats.dailyPoints, stage === 'evening' ? 200 : 112);
    assert.equal(stats.captures, 10);
    assert.equal(awards.at(-1), 0);
    assert.ok(awards.some((award) => award > 0 && award < 10));
  }
});

test('migrates legacy positions and keeps previously recorded captures', async (t) => {
  const id = 'a'.repeat(32);
  const app = await preview(t, { seed(filename, now) {
    const db = new DatabaseSync(filename);
    try {
      db.exec(`
        CREATE TABLE players (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'cat',
          stage TEXT NOT NULL DEFAULT 'evening', sharing INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
        CREATE TABLE positions (user_id TEXT NOT NULL PRIMARY KEY REFERENCES players(id), role TEXT NOT NULL,
          lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE captures (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id),
          stage TEXT NOT NULL, mouse_id INTEGER NOT NULL, zone_id TEXT NOT NULL, completed_at INTEGER NOT NULL,
          meters INTEGER NOT NULL, awarded INTEGER NOT NULL, UNIQUE (player_id, stage, mouse_id));
        CREATE INDEX captures_by_zone ON captures(stage, zone_id, completed_at);
      `);
      db.prepare("INSERT INTO players (id, nickname, created_at) VALUES (?, 'Legacy cat', ?)").run(id, now);
      db.prepare("INSERT INTO positions VALUES (?, 'cat', ?, ?, ?, ?)").run(id, point.lat, point.lng, point.accuracy, now);
      db.prepare("INSERT INTO captures VALUES ('legacy', ?, 'evening', 4, 'central', ?, 1280, 10)").run(id, now - 1000);
    } finally {
      db.close();
    }
  } });
  const cat = app.player(`campus_demo=${id}`);
  const mouse = await app.join({ role: 'mouse' });
  await mouse.post('position', point);
  assert.equal((await cat.get('position')).session_id, null);
  const code = await issue(mouse);
  rejected(await cat.capture(code), 'SESSION');
  assert.equal((await cat.post('position', point)).session_id, '2026-11-23:evening');
  await cat.post('tracking', { active: true });
  await cat.post('move', {}, randomUUID());
  const capture = accepted(await cat.capture(code));
  const records = (await cat.get('state')).captures;
  assert.deepEqual(records.map(({ id, mouseId, award }) => [id, mouseId, award]), [[capture.id, 3, 10], ['legacy', 4, 10]]);
});
