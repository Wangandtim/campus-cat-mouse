import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createPreviewApi, openPreview } from '../api.mjs';
import { DatabaseBusyError } from '../db/capacity.mjs';
import { connectRedis } from './redis.mjs';
import { attachLivePositions } from './positions.mjs';

function nextSnapshot(socket) {
  return once(socket, 'live:positions', { signal: AbortSignal.timeout(7000) });
}

async function preview(t, clock, decorateLiveGame = (liveGame) => liveGame, redis,
  decoratePositions = (positions) => positions, writeBehind = false) {
  const directory = mkdtempSync(join(tmpdir(), 'campus-live-test-'));
  const { game, liveGame, positions, close } = openPreview(join(directory, 'test.sqlite3'), undefined, clock);
  const clients = [];
  const server = createServer((req, res) => void api(req, res));
  const { io, profileChanged, positionQueueStats } = attachLivePositions(server, {
    game: decorateLiveGame(liveGame), positions: decoratePositions(positions), clock, redis, writeBehind,
  });
  const api = createPreviewApi({}, game, positions, profileChanged);
  t.after(async () => {
    for (const client of clients) client.disconnect();
    await io.close();
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  function client(cookie) {
    const socket = connect(base, {
      autoConnect: false, forceNew: true, transports: ['websocket'],
      extraHeaders: cookie ? { Cookie: cookie } : {},
    });
    clients.push(socket);
    return socket;
  }

  async function player(profile) {
    const state = await fetch(`${base}/api/preview/state`);
    const cookie = state.headers.getSetCookie()[0].split(';')[0];
    async function update(body) {
      const response = await fetch(`${base}/api/preview/profile`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
    }
    if (profile) await update(profile);
    const socket = client(cookie);
    const ready = once(socket, 'live:ready');
    socket.connect();
    return { socket, update, cookie, room: (await ready)[0] };
  }

  return { base, client, player, profileChanged, positionQueueStats, positions, io };
}

const center = { lat: 34.17942, lng: 108.91808, accuracy: 13 };
const activeTime = Date.parse('2026-11-23T17:45:00+08:00');

function sample(sampleId) {
  return { ...center, lng: center.lng + sampleId * 0.00001, sampleId, sampledAt: activeTime + sampleId };
}

async function retryFixture(t, beforeSave) {
  const attempts = [];
  const server = await preview(t, () => activeTime, undefined, undefined, (positions) => ({
    ...positions,
    async save(id, point, ...args) {
      const attempt = { lng: point.lng, at: performance.now() };
      attempts.push(attempt);
      await beforeSave(attempt, attempts.length);
      return positions.save(id, point, ...args);
    },
  }));
  const { socket, cookie } = await server.player();
  const id = cookie.split('=')[1];
  async function waitForStored({ lng }) {
    const signal = AbortSignal.timeout(2000);
    while ((await server.positions.get(id))?.lng !== lng) await delay(10, undefined, { signal });
  }
  return { socket, attempts, waitForStored, connectedSocket: server.io.of('/').sockets.get(socket.id) };
}

for (const error of [new DatabaseBusyError('Database queue is full.'),
  new Error('Database queue timed out.'), new Error('数据库暂时忙，请稍后重试。')]) {
  test(`retries the latest position once after ${error.message}`, { timeout: 6000 }, async (t) => {
    const { socket, attempts, waitForStored } = await retryFixture(t, (_attempt, count) => {
      if (count === 1) throw error;
    });
    const first = sample(1);
    socket.emit('live:position', first);
    await waitForStored(first);
    socket.emit('live:position', first);
    socket.emit('live:position', { ...first, sampledAt: first.sampledAt + 1 });
    socket.emit('live:position', sample(2));
    await waitForStored(sample(2));
    assert.deepEqual(attempts.map(({ lng }) => lng), [first.lng, first.lng, sample(2).lng]);
    assert.ok(attempts[1].at - attempts[0].at >= 145, 'the server waits before retrying');
  });
}

test('write-behind accepts a position without waiting for a stalled database and drains it later',
  { timeout: 8000 }, async (t) => {
    let failing = true;
    let attempts = 0;
    const server = await preview(t, () => activeTime, undefined, undefined, (positions) => ({
      ...positions,
      async save(...args) {
        attempts++;
        if (failing) throw new DatabaseBusyError('Database queue is full.');
        return positions.save(...args);
      },
    }), true);
    const { socket, cookie } = await server.player();
    const id = cookie.split('=')[1];
    let liveError;
    socket.on('live:error', (message, detail) => { liveError = { message, detail }; });
    socket.emit('live:position', sample(1));
    for (let i = 0; i < 40 && attempts === 0; i++) await delay(10);
    assert.equal(attempts, 1);
    assert.equal(liveError, undefined);
    assert.ok(server.positionQueueStats().queued >= 0);
    failing = false;
    const signal = AbortSignal.timeout(3000);
    while ((await server.positions.get(id))?.lng !== sample(1).lng) await delay(10, undefined, { signal });
    assert.equal(liveError, undefined);
    assert.equal(server.positionQueueStats().drops, 0);
  });

test('issues a sample-specific retry hint and saves a successful resend only once', { timeout: 6000 }, async (t) => {
  const { socket, attempts, waitForStored } = await retryFixture(t, (_attempt, count) => {
    if (count <= 2) throw new DatabaseBusyError('Database queue timed out.');
  });
  const first = sample(1);
  const failed = once(socket, 'live:error', { signal: AbortSignal.timeout(2000) });
  socket.emit('live:position', first);
  const [message, detail] = await failed;
  assert.equal(message, '活动定位暂不可用。');
  assert.equal(detail?.code, 'POSITION_RETRY_RETRYABLE');
  assert.equal(detail.sampleId, first.sampleId);
  assert.ok(detail.retryAfter > 0);
  assert.equal(attempts.length, 2);

  socket.emit('live:position', first);
  socket.emit('live:position', first);
  await waitForStored(first);
  socket.emit('live:position', first);
  socket.emit('live:position', sample(2));
  await waitForStored(sample(2));
  assert.deepEqual(attempts.map(({ lng }) => lng), [first.lng, first.lng, first.lng, sample(2).lng]);
});

test('does not retry again when the one client resend also fails', { timeout: 6000 }, async (t) => {
  const { socket, attempts, waitForStored } = await retryFixture(t, ({ lng }) => {
    if (lng === sample(1).lng) throw new DatabaseBusyError('busy');
  });
  for (const _ of [1, 2]) {
    const failed = once(socket, 'live:error', { signal: AbortSignal.timeout(2000) });
    socket.emit('live:position', sample(1));
    assert.equal((await failed)[1]?.code, 'POSITION_RETRY_RETRYABLE');
  }
  socket.emit('live:position', sample(1));
  socket.emit('live:position', sample(2));
  await waitForStored(sample(2));
  assert.deepEqual(attempts.map(({ lng }) => lng), [sample(1).lng, sample(1).lng, sample(1).lng, sample(2).lng]);
});

test('a recovered socket ignores a previously committed position', { timeout: 9000 }, async (t) => {
  const { socket, attempts, waitForStored } = await retryFixture(t, () => {});
  socket.emit('live:position', sample(1));
  await waitForStored(sample(1));
  const ready = once(socket, 'live:ready', { signal: AbortSignal.timeout(5000) });
  socket.io.engine.close();
  await ready;
  assert.equal(socket.recovered, true);

  socket.emit('live:position', sample(1));
  socket.emit('live:position', sample(2));
  await waitForStored(sample(2));
  assert.deepEqual(attempts.map(({ lng }) => lng), [sample(1).lng, sample(2).lng]);
});

test('coalesces waiting positions to the newest and drops a failed superseded sample', { timeout: 6000 }, async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { socket, connectedSocket, attempts, waitForStored } = await retryFixture(t, async (_attempt, count) => {
    if (count === 1) {
      started.resolve();
      await release.promise;
      throw new DatabaseBusyError('busy');
    }
  });
  t.after(() => release.resolve());
  const newest = Promise.withResolvers();
  connectedSocket.on('live:position', ({ sampleId }) => { if (sampleId === 4) newest.resolve(); });
  socket.emit('live:position', sample(1));
  await started.promise;
  for (const id of [2, 3, 4]) socket.emit('live:position', sample(id));
  await newest.promise;
  release.resolve();
  await waitForStored(sample(4));

  socket.emit('live:position', sample(1));
  socket.emit('live:position', { ...sample(5), sampledAt: sample(3).sampledAt });
  socket.emit('live:position', sample(6));
  await waitForStored(sample(6));
  assert.deepEqual(attempts.map(({ lng }) => lng), [sample(1).lng, sample(4).lng, sample(6).lng]);
});

test('clearing a position during backoff retires its sample ID', { timeout: 6000 }, async (t) => {
  const failed = Promise.withResolvers();
  const { socket, connectedSocket, attempts, waitForStored } = await retryFixture(t, (_attempt, count) => {
    if (count === 1) {
      failed.resolve();
      throw new DatabaseBusyError('busy');
    }
  });
  socket.emit('live:position', sample(1));
  await failed.promise;
  const cleared = once(connectedSocket, 'live:clear-position');
  socket.emit('live:clear-position');
  await cleared;
  socket.emit('live:position', sample(1));
  socket.emit('live:position', sample(2));
  await waitForStored(sample(2));
  assert.deepEqual(attempts.map(({ lng }) => lng), [sample(1).lng, sample(2).lng]);
});

test('requires a preview cookie and hides positions outside the activity window', { timeout: 10000 }, async (t) => {
  const server = await preview(t, () => activeTime - 60 * 60_000);
  const guest = server.client();
  const denied = once(guest, 'connect_error');
  guest.connect();
  assert.match((await denied)[0].message, /重新进入/);

  const { socket, room } = await server.player();
  assert.equal(room.eventId, null);
  const rejected = once(socket, 'live:error');
  socket.volatile.emit('live:position', center);
  assert.match((await rejected)[0], /未开启活动定位/);
});

test('skips a timed out player batch without clearing rooms or broadcasting to unchecked peers',
  { timeout: 12000 }, async (t) => {
    const entered = Promise.withResolvers();
    const blocked = Promise.withResolvers();
    let blockedPlayer;
    let holdBatch = true;
    const server = await preview(t, () => activeTime, (liveGame) => ({
      ...liveGame,
      async getPlayers(ids, ...args) {
        if (holdBatch && blockedPlayer && ids.includes(blockedPlayer)) {
          entered.resolve();
          await blocked.promise;
          if (holdBatch) throw new Error('temporary player query failure');
        }
        return liveGame.getPlayers(ids, ...args);
      },
    }));
    const affected = await server.player();
    const unaffected = await server.player();
    const mouse = await server.player({ role: 'mouse' });
    mouse.socket.volatile.emit('live:position', center);
    await nextSnapshot(unaffected.socket);

    let affectedSnapshots = 0;
    let nullRooms = 0;
    affected.socket.on('live:positions', () => { affectedSnapshots++; });
    affected.socket.on('live:ready', (room) => { if (!room.eventId) nullRooms++; });
    blockedPlayer = affected.cookie.split('=')[1];
    server.profileChanged(blockedPlayer);
    await entered.promise;

    await nextSnapshot(unaffected.socket);
    assert.equal(affectedSnapshots, 0, 'the unchecked peer must not receive a room broadcast');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(affectedSnapshots, 0, 'a timed out batch must be skipped for that broadcast');
    assert.equal(affected.socket.connected, true, 'the failed lookup must preserve the connection');
    assert.equal(nullRooms, 0, 'a transient lookup failure must not clear the joined room');

    holdBatch = false;
    blocked.resolve();
    await nextSnapshot(affected.socket);
    assert.equal(affected.socket.connected, true);
    assert.equal(nullRooms, 0);
  });

test('revalidates each recovered player and restores snapshots for the remaining players',
  { timeout: 12000 }, async (t) => {
    let rejectedId;
    const server = await preview(t, () => activeTime, (liveGame) => ({
      ...liveGame,
      async getPlayers(ids, ...args) {
        return (await liveGame.getPlayers(ids, ...args)).filter(({ id }) => id !== rejectedId);
      },
    }));
    const [first, excluded, last, mouse] = await Promise.all([
      server.player(), server.player(), server.player(), server.player({ role: 'mouse' }),
    ]);
    rejectedId = excluded.cookie.split('=')[1];
    await nextSnapshot(first.socket);
    const denied = once(excluded.socket, 'connect_error', { signal: AbortSignal.timeout(5000) });
    const ready = Promise.all([first, last].map(({ socket }) => once(socket, 'live:ready',
      { signal: AbortSignal.timeout(5000) })));
    for (const { socket } of [first, excluded, last]) {
      socket.io.reconnectionDelay(50);
      socket.io.randomizationFactor(0);
      socket.io.engine.close();
    }
    assert.match((await denied)[0].message, /重新进入/);
    for (const [room] of await ready) assert.equal(room.eventId, first.room.eventId);
    assert.ok(first.socket.recovered && last.socket.recovered && mouse.socket.connected);
    assert.equal(excluded.socket.connected, false);
    const snapshots = Promise.all([first, last].map(({ socket }) => nextSnapshot(socket)));
    mouse.socket.emit('live:position', center);
    for (const [, markers] of await snapshots) assert.equal(markers[0].lat, center.lat);
  });

test('rejects recovery when the authenticated account changed', { timeout: 8000 }, async (t) => {
  const server = await preview(t, () => activeTime);
  const [first, second] = await Promise.all([server.player(), server.player()]);
  const denied = once(first.socket, 'connect_error', { signal: AbortSignal.timeout(5000) });
  first.socket.io.opts.extraHeaders.Cookie = second.cookie;
  first.socket.io.engine.close();
  assert.match((await denied)[0].message, /重新进入/);
  assert.equal(first.socket.connected, false);
  assert.equal(second.socket.connected, true);
});

test('sends ten exact mouse locations, filters cats at 300 m, and requires a fresh location on reconnect',
  { timeout: 30000 }, async (t) => {
    const server = await preview(t, () => activeTime);
    const cat = await server.player();
    const farCat = await server.player();
    const mice = await Promise.all(Array.from({ length: 10 }, () => server.player({ role: 'mouse' })));
    const otherStage = await server.player({ role: 'mouse', stage: 'morning' });
    assert.equal(otherStage.room.eventId, null);
    const invalid = once(cat.socket, 'live:error');
    cat.socket.volatile.emit('live:position', { lat: 'invalid' });
    assert.match((await invalid)[0], /有效的坐标/);
    const ready = Promise.all([nextSnapshot(cat.socket), nextSnapshot(mice[0].socket)]);
    cat.socket.volatile.emit('live:position', { ...center, lat: center.lat + 0.00268 });
    farCat.socket.volatile.emit('live:position', { ...center, lat: center.lat + 0.00270 });
    const points = mice.map((_, index) => ({ ...center, lng: center.lng + 0.00001 * index }));
    mice.forEach(({ socket }, index) => socket.volatile.emit('live:position', points[index]));
    const [[eventId, visibleMice], [, visibleCats]] = await ready;
    assert.equal(eventId, cat.room.eventId);
    assert.deepEqual(visibleMice.map(({ lng }) => lng).sort(), points.map(({ lng }) => lng).sort());
    assert.ok(visibleMice.every(({ id, role }) => role === 'mouse' && !mice.some(({ cookie }) => cookie.endsWith(id))));
    assert.deepEqual(visibleCats.map(({ lat }) => lat), [center.lat + 0.00268]);

    const mine = await fetch(`${server.base}/api/preview/position`, { headers: { Cookie: mice[0].cookie } });
    assert.equal((await mine.json()).accuracy, center.accuracy);

    const paused = once(mice[0].socket, 'live:ready');
    await mice[0].update({ sharing: false });
    assert.equal((await paused)[0].eventId, null);
    const reconnected = once(mice[1].socket, 'live:ready', { signal: AbortSignal.timeout(5000) });
    mice[1].socket.io.engine.close();
    assert.equal((await reconnected)[0].eventId, eventId);
    assert.equal(mice[1].socket.recovered, true);
    const [, duringPause] = await nextSnapshot(cat.socket);
    assert.equal(duringPause.length, 8);

    const resumed = once(mice[0].socket, 'live:ready');
    await mice[0].update({ sharing: true });
    await resumed;
    mice[0].socket.volatile.emit('live:position', points[0]);
    mice[1].socket.volatile.emit('live:position', points[1]);
    const [, afterResume] = await nextSnapshot(cat.socket);
    assert.equal(afterResume.length, 10);
  });

test('backfills only the latest eligible GEO point after a Redis disconnect',
  { skip: !process.env.REDIS_TEST_URL, timeout: 15000 }, async (t) => {
    const url = new URL(process.env.REDIS_TEST_URL);
    assert.equal(url.hostname, '127.0.0.1');
    url.pathname = '/15';
    const redis = await connectRedis(url.href);
    t.after(() => { if (redis.isOpen) redis.destroy(); });
    await redis.flushDb();
    let now = activeTime;
    let pausedId;
    const server = await preview(t, () => now, (liveGame) => ({
      ...liveGame,
      async getPlayers(ids, ...args) {
        return (await liveGame.getPlayers(ids, ...args)).map((player) =>
          player.id === pausedId ? { ...player, sharing: false } : player);
      },
    }), redis);
    const [expired, live, paused, exited] = await Promise.all(
      Array.from({ length: 4 }, () => server.player({ role: 'mouse' })));

    async function submit({ socket, cookie }, point) {
      socket.emit('live:position', point);
      const signal = AbortSignal.timeout(3000);
      const id = cookie.split('=')[1];
      while ((await server.positions.get(id))?.lng !== point.lng) await delay(20, undefined, { signal });
    }
    redis.destroy();
    await submit(expired, center);
    now += 16_000;
    await Promise.all([live, paused, exited].map((player) => submit(player, center)));
    now += 1000;
    const latest = { ...center, lng: center.lng + 0.00001 };
    await submit(live, latest);
    // Simulate a pause or safety-house update whose pub/sub notification was missed.
    pausedId = paused.cookie.split('=')[1];
    const disconnected = once(server.io.of('/').sockets.get(exited.socket.id), 'disconnect');
    exited.socket.disconnect();
    await disconnected;
    await redis.connect();

    const key = `campus-live:${live.room.eventId}:geo:mouse`;
    const signal = AbortSignal.timeout(4000);
    let members;
    while (!(members = await redis.zRange(key, 0, -1)).length) await delay(20, undefined, { signal });
    assert.deepEqual(members, [live.socket.id]);
    const stored = JSON.parse(await redis.get(`${key}:point:${live.socket.id}`));
    assert.equal(stored.lng, latest.lng);
    assert.equal(stored.updatedAt, now);
    assert.equal(paused.socket.connected, true);
  });

test('invalidates shared player state across Socket.IO instances through Redis pub/sub',
  { skip: !process.env.REDIS_TEST_URL, timeout: 15000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'campus-live-multi-test-'));
    const { game, liveGame, positions, close } = openPreview(join(directory, 'test.sqlite3'), undefined, () => activeTime);
    const url = new URL(process.env.REDIS_TEST_URL);
    assert.equal(url.hostname, '127.0.0.1');
    url.pathname = '/14';
    const redis = await connectRedis(url.href);
    await redis.flushDb();
    const clients = [];
    const firstServer = createServer((req, res) => void api(req, res));
    const secondServer = createServer((req, res) => void api(req, res));
    const first = attachLivePositions(firstServer, { game: liveGame, positions, redis, clock: () => activeTime });
    const second = attachLivePositions(secondServer, { game: liveGame, positions, redis, clock: () => activeTime });
    const api = createPreviewApi({}, game, positions, first.profileChanged);
    const closeServer = async (server, attached) => {
      for (const client of clients) client.disconnect();
      await attached.io.close();
    };
    t.after(async () => {
      await closeServer(firstServer, first);
      await closeServer(secondServer, second);
      redis.destroy();
      await close();
      rmSync(directory, { recursive: true, force: true });
    });
    firstServer.listen(0, '127.0.0.1');
    secondServer.listen(0, '127.0.0.1');
    await Promise.all([once(firstServer, 'listening'), once(secondServer, 'listening')]);
    const firstBase = `http://127.0.0.1:${firstServer.address().port}`;
    const secondBase = `http://127.0.0.1:${secondServer.address().port}`;
    const state = await fetch(`${firstBase}/api/preview/state`);
    const cookie = state.headers.getSetCookie()[0].split(';')[0];
    const catState = await fetch(`${firstBase}/api/preview/state`);
    const catCookie = catState.headers.getSetCookie()[0].split(';')[0];
    const update = async (body) => fetch(`${firstBase}/api/preview/profile`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await update({ role: 'mouse' })).status, 200);

    const mouse = connect(secondBase, { autoConnect: false, forceNew: true, transports: ['websocket'],
      extraHeaders: { Cookie: cookie } });
    const cat = connect(secondBase, { autoConnect: false, forceNew: true, transports: ['websocket'],
      extraHeaders: { Cookie: catCookie } });
    clients.push(mouse, cat);
    const connectErrors = [];
    mouse.on('connect_error', (error) => connectErrors.push(`mouse: ${error.message}`));
    cat.on('connect_error', (error) => connectErrors.push(`cat: ${error.message}`));
    const mouseReady = once(mouse, 'live:ready', { signal: AbortSignal.timeout(5000) });
    const catReady = once(cat, 'live:ready', { signal: AbortSignal.timeout(5000) });
    mouse.connect();
    cat.connect();
    let rooms;
    try { rooms = await Promise.all([mouseReady, catReady]); }
    catch { throw new Error(`Socket.IO handshake failed: ${connectErrors.join('; ') || 'live:ready timeout'}`); }
    assert.equal(rooms[0][0].eventId, '2026-11-23:evening');
    assert.equal(rooms[1][0].eventId, '2026-11-23:evening');
    const visible = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mouse location was not visible')), 5000);
      cat.on('live:positions', (_eventId, markers) => {
        if (markers.some((marker) => marker.role === 'mouse')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    mouse.volatile.emit('live:position', center);
    await visible;
    await delay(150);

    const paused = once(mouse, 'live:ready', { signal: AbortSignal.timeout(5000) });
    assert.equal((await update({ sharing: false })).status, 200);
    assert.equal((await paused)[0].eventId, null);
    assert.equal(mouse.connected, true, 'state invalidation does not disconnect the existing socket');
  });
