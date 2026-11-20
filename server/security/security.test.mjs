import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SignJWT } from 'jose';
import { createConnection } from 'mysql2/promise';
import { createClient } from 'redis';
import { io as connect } from 'socket.io-client';
import { firstEventDate } from '../admin/common.mjs';
import { createPreviewApi, createPreviewServices } from '../api.mjs';
import { createSessions } from '../auth/session.mjs';
import { openSqliteStore } from '../database.mjs';
import { eventId } from '../db/migrations.mjs';
import { openMysqlStore } from '../db/mysql.mjs';
import { attachLivePositions } from '../live/positions.mjs';
import { limits, sessionWindow } from '../rules.mjs';
import { createRateLimiter, limitLiveReports } from './rate-limit.mjs';
import { positionRetentionMs, retentionSettings } from './retention.mjs';

const day = firstEventDate;
const morning = sessionWindow(day, 'morning');
const evening = sessionWindow(day, 'evening');
const activeTime = evening.startsAt + 15 * 60_000;
const publicOrigin = 'https://campus-p07a.invalid';
const teacher = '13901234567';
const phone = '13976543210';
const email = 'private-student@example.invalid';
const secretText = 'secret-token-for-test';
const passwordText = 'password-for-test';
const point = { lat: 34.179421, lng: 108.918081, accuracy: 10 };
const [cat, mouse, retired] = ['c', 'm', 'r'].map((letter) => letter.repeat(32));

test('retention settings use one hour, sixty seconds and thirty seconds and bound configured values', () => {
  assert.deepEqual(retentionSettings({}), {
    exportRetentionMs: 3_600_000, positionRetentionMs: 60_000, positionSweepMs: 30_000,
  });
  assert.deepEqual(retentionSettings({
    CAMPUS_EXPORT_RETENTION_SECONDS: '1800', CAMPUS_POSITION_RETENTION_SECONDS: '75', CAMPUS_POSITION_SWEEP_SECONDS: '15',
  }), { exportRetentionMs: 1_800_000, positionRetentionMs: 75_000, positionSweepMs: 15_000 });
  assert.throws(() => retentionSettings({ CAMPUS_POSITION_RETENTION_SECONDS: '30' }), /CAMPUS_POSITION_RETENTION_SECONDS/);
  assert.throws(() => retentionSettings({ CAMPUS_POSITION_SWEEP_SECONDS: '2147484' }), /CAMPUS_POSITION_SWEEP_SECONDS/);
  assert.throws(() => retentionSettings({ CAMPUS_EXPORT_RETENTION_SECONDS: '0.5' }), /CAMPUS_EXPORT_RETENTION_SECONDS/);
});

async function fixtureStore(t, mysql) {
  if (!mysql) return { store: openSqliteStore(':memory:'), close: async (store) => store.close() };
  const url = new URL(process.env.MYSQL_TEST_URL);
  assert.equal(url.hostname, '127.0.0.1');
  const schema = `p07a_${randomUUID().replaceAll('-', '')}`;
  url.pathname = '/';
  const admin = await createConnection(url.href);
  t.after(() => admin.end());
  await admin.query(`CREATE DATABASE \`${schema}\``);
  url.pathname = `/${schema}`;
  return {
    store: await openMysqlStore(url.href),
    async close(store) {
      await store.close();
      // Drop only the schema created by this fixture.
      const cleanup = await createConnection({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password) });
      try { await cleanup.query(`DROP DATABASE \`${schema}\``); } finally { await cleanup.end(); }
    },
  };
}

async function openApi(t, { mysql = false, secure = false, redis } = {}) {
  let now = morning.startsAt - 1000;
  const clock = () => now;
  const { store, close } = await fixtureStore(t, mysql);
  let cleanup = () => close(store);
  t.after(() => cleanup());
  const { users } = store.tables;
  await store.transaction(async (tx) => {
    for (const [index, id] of [cat, mouse, retired].entries()) {
      await tx.run(`INSERT INTO ${users}
        (id, openid, nickname, name, student_id, gender, grade, college, class_name, phone, email, created_at)
        VALUES (?, ?, ?, ?, ?, 'male', '2026', '测试学院', '测试班', ?, ?, ?)`,
      id, `p07a:${id}`, `测试学生${index}`, `测试学生${index}`, `p07a-test-${index}`, phone, email, now);
      await tx.run('INSERT INTO event_registrations (user_id, event_id, created_at) VALUES (?, ?, ?)', id, eventId, now);
    }
  });
  const playerKey = randomBytes(32);
  const teacherKey = randomBytes(32);
  const hash = `${randomBytes(16).toString('base64url')}.${randomBytes(64).toString('base64url')}`;
  const env = {
    NODE_ENV: secure ? 'production' : 'test',
    CAMPUS_AUTH_MODE: secure ? 'wechat' : 'mock',
    CAMPUS_TRUSTED_PROXY_IPS: '',
    CAMPUS_ROSTER_CSV: '',
    CAMPUS_JWT_SECRET: playerKey.toString('base64url'),
    CAMPUS_TEACHER_ALLOWLIST: teacher,
    CAMPUS_TEACHER_PASSWORD_HASHES: JSON.stringify({ [teacher]: hash }),
    CAMPUS_TEACHER_JWT_SECRET: teacherKey.toString('base64url'),
  };
  if (secure) {
    const directory = await mkdtemp(join(tmpdir(), 'campus-p07a-roster-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const roster = join(directory, 'roster.csv');
    await writeFile(roster, 'school,student_no,name\n西安欧亚学院,p07a-test-0,测试学生0\n');
    Object.assign(env, {
      CAMPUS_PUBLIC_ORIGIN: publicOrigin,
      CAMPUS_ROSTER_CSV: roster,
      WECHAT_APP_ID: 'synthetic-app',
      WECHAT_APP_SECRET: 'synthetic-app-secret',
      WECHAT_REDIRECT_ALLOWLIST: `${publicOrigin}/api/auth/callback`,
      CAMPUS_RESEND_API_KEY: '',
      CAMPUS_MAIL_FROM: '',
    });
  }
  const app = createPreviewServices(store, clock);
  const server = createServer((req, res) => void api(req, res));
  const { io, profileChanged } = attachLivePositions(server, { game: app.liveGame, positions: app.positions, redis, clock });
  const checkLimit = createRateLimiter({ env, redis, clock });
  limitLiveReports(io, checkLimit);
  const api = createPreviewApi(env, app.game, app.positions, profileChanged, checkLimit);
  const sockets = [];
  cleanup = async () => {
    for (const socket of sockets) socket.disconnect();
    await io.close();
    await close(store);
  };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const localOrigin = `http://127.0.0.1:${port}`;
  const origin = secure ? publicOrigin : localOrigin;
  const proxyHeaders = secure ? { Host: new URL(origin).host, 'X-Forwarded-Proto': 'https' } : {};
  const sessions = createSessions(playerKey, secure ? origin : 'urn:campus:mock', secure, clock);
  const cookiePrefix = secure ? '__Host-' : '';

  return {
    ...app, store,
    setNow(time) { now = time; },
    async teacherCookie() {
      const seconds = Math.floor(clock() / 1000);
      const token = await new SignJWT({ role: 'teacher' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('campus-admin').setAudience('campus-teacher').setSubject(teacher).setJti(randomUUID())
        .setIssuedAt(seconds).setExpirationTime(seconds + 60 * 60).sign(teacherKey);
      return `${cookiePrefix}campus_teacher=${token}`;
    },
    async playerCookie(id) {
      let cookie;
      await sessions.write({ appendHeader: (_header, value) => { cookie = value.split(';')[0]; } }, 'player', id);
      return cookie;
    },
    async socket(cookie) {
      const socket = connect(localOrigin, { autoConnect: false, transports: ['websocket'], forceNew: true,
        reconnection: false, extraHeaders: { ...proxyHeaders, Cookie: cookie } });
      sockets.push(socket);
      const ready = once(socket, 'live:ready', { signal: AbortSignal.timeout(5000) });
      socket.connect();
      assert.equal((await ready)[0].eventId, evening.id);
      return socket;
    },
    request(path, { body, cookie, headers } = {}) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
          headers: { ...proxyHeaders, Origin: origin, ...(cookie && { Cookie: cookie }),
            ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
        };
        const req = request(options, async (res) => {
          try {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            resolve({ status: res.statusCode, headers: res.headers, bytes, json: () => JSON.parse(bytes) });
          } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    },
  };
}

async function startTracking(app, id) {
  const cookie = await app.playerCookie(id);
  const start = await app.request('/api/preview/tracking', { cookie, body: { active: true, sessionId: evening.id } });
  assert.equal(start.status, 200);
  return cookie;
}

for (const mysql of [false, true]) {
  test(`P0-7a ${mysql ? 'MySQL' : 'SQLite'} keeps capture positions and strips sensitive audit data`,
    { skip: mysql && !process.env.MYSQL_TEST_URL, timeout: 25_000 }, async (t) => {
      const app = await openApi(t, { mysql });
      const { store } = app;
      const errors = t.mock.method(console, 'error', () => {});
      const warnings = t.mock.method(console, 'warn', () => {});
      const adminCookie = await app.teacherCookie();
      const post = (path, body, cookie = adminCookie) => app.request(path, { body, cookie });
      const badLogin = await post('/api/teacher/login', { account: teacher, password: passwordText }, '');
      assert.equal(badLogin.status, 401);
      const badCallback = await app.request(`/api/auth/callback?code=${secretText}`);
      assert.equal(badCallback.status, 400);
      assert.equal((await post('/api/admin/assignments', { eventDate: day, userId: retired })).status, 200);
      const note = `${secretText} ${passwordText} ${phone} ${email} ${point.lat}, ${point.lng}`;
      assert.equal((await post('/api/admin/assignments', { eventDate: day, userId: mouse, replaceUserId: retired, reason: note })).status, 200);
      const list = await post('/api/admin/students', { query: '测试学生' });
      assert.equal(list.status, 200);
      assert.equal(list.headers['cache-control'], 'no-store');
      assert.equal(list.json().length, 3);
      assert.ok(list.json().every((student) => student.phone === '***3210' && student.email === 'p***@example.invalid'));
      const dashboard = await post('/api/admin/dashboard', { assignmentDate: day, snapshotDate: day });
      assert.equal(dashboard.status, 200);
      assert.equal(dashboard.json().assignment.rows[0].phone, '***3210');

      const download = await post('/api/admin/export', { eventDate: day });
      assert.equal(download.status, 200);
      assert.equal(download.headers['cache-control'], 'no-store');
      assert.match(download.headers['content-disposition'], /attachment/);
      const unauthorized = await post('/api/admin/export', { eventDate: day }, await app.playerCookie(cat));
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers['cache-control'], 'no-store');
      assert.equal((await app.request('/api/admin/export')).status, 405);
      assert.equal((await post('/api/admin/export', { eventDate: secretText })).status, 400);

      app.setNow(activeTime - limits.positionAge - 1000);
      const catCookie = await startTracking(app, cat);
      const mouseCookie = await startTracking(app, mouse);
      await startTracking(app, retired);
      app.setNow(activeTime - limits.positionAge);
      for (const cookie of [catCookie, mouseCookie]) {
        const write = await post('/api/preview/position', { ...point, sessionId: evening.id }, cookie);
        assert.equal(write.status, 200);
        assert.equal(write.json().lat, point.lat);
      }
      await store.transaction(async (tx) => {
        await tx.savePosition(retired, point, activeTime - positionRetentionMs - 1);
        await tx.run('UPDATE participation_sessions SET valid_meters = 140, last_movement_at = ? WHERE player_id = ?',
          activeTime - limits.positionAge, cat);
      });
      app.setNow(activeTime);
      const configuredRetention = retentionSettings({ CAMPUS_POSITION_RETENTION_SECONDS: '75' }).positionRetentionMs;
      await app.purgeLocations(activeTime, configuredRetention);
      assert.ok(await app.positions.get(retired));
      await app.purgeLocations();
      assert.equal(await app.positions.get(retired), null);
      assert.equal((await app.positions.get(cat)).updated_at, activeTime - limits.positionAge);
      assert.equal((await app.positions.get(mouse)).updated_at, activeTime - limits.positionAge);
      assert.equal((await app.request('/api/preview/position', { cookie: mouseCookie })).json().lng, point.lng);
      const { code } = (await post('/api/preview/mouse-code', {}, mouseCookie)).json();
      const capture = await app.request('/api/preview/capture',
        { cookie: catCookie, body: { code }, headers: { 'Idempotency-Key': randomUUID() } });
      assert.equal(capture.status, 200, capture.bytes.toString());
      assert.equal(capture.json().award, 10);

      if (!mysql) {
        const [observer, participant] = await Promise.all([app.socket(catCookie), app.socket(mouseCookie)]);
        const firstSnapshot = once(observer, 'live:positions', { signal: AbortSignal.timeout(6500) });
        participant.emit('live:position', { ...point, sessionId: evening.id });
        assert.equal((await firstSnapshot)[1][0].lat, point.lat);
        const paused = once(participant, 'live:ready', { signal: AbortSignal.timeout(5000) });
        assert.equal((await post('/api/preview/tracking', { active: false, sessionId: evening.id }, mouseCookie)).status, 200);
        assert.equal((await paused)[0].eventId, null);
        const [, markers] = await once(observer, 'live:positions', { signal: AbortSignal.timeout(6500) });
        assert.deepEqual(markers, []);
        assert.equal((await app.request('/api/preview/position', { cookie: mouseCookie })).json().lat, undefined);
        observer.disconnect();
        participant.disconnect();
      }
      assert.equal((await post('/api/preview/profile', { sharing: false }, mouseCookie)).status, 200);
      assert.equal((await app.request('/api/preview/position', { cookie: mouseCookie })).json().lng, undefined);

      app.setNow(evening.endsAt - 500);
      const newCatCookie = await app.playerCookie(cat);
      assert.equal((await post('/api/preview/position', { ...point, sessionId: evening.id }, newCatCookie)).status, 200);
      app.setNow(evening.endsAt);
      assert.equal((await app.request('/api/preview/position', { cookie: newCatCookie })).json().lat, undefined);
      await app.game.settleDue(evening.endsAt);
      const summary = 'SELECT player_id, status, valid_meters, data_gap_seconds FROM participation_sessions ORDER BY player_id';
      const before = await store.read((tx) => tx.all(summary));
      assert.ok(before.some(({ status }) => status === 'settled'));
      assert.ok(before.some(({ status }) => status === 'void'));
      await store.transaction((tx) => tx.run('UPDATE participation_sessions SET anchor_lat = ?, anchor_lng = ?', point.lat, point.lng));
      await app.purgeLocations();
      assert.deepEqual(await store.read((tx) => tx.all(summary)), before);
      assert.equal((await store.read((tx) => tx.all('SELECT player_id FROM participation_sessions WHERE anchor_lat IS NOT NULL OR anchor_lng IS NOT NULL'))).length, 0);
      assert.equal((await app.positions.get(cat)).updated_at, evening.endsAt - 500);

      const adminAudit = await store.read((tx) => tx.all('SELECT action, actor_id, details FROM admin_audit'));
      const gameAudit = await store.read((tx) => tx.all('SELECT action, details FROM audit_logs'));
      assert.equal(adminAudit.filter(({ action }) => action === 'login.failed').length, 2);
      for (const action of ['roster.assigned', 'roster.replaced', 'export.succeeded', 'export.failed']) {
        assert.ok(adminAudit.some((row) => row.action === action), action);
      }
      for (const action of ['session_settled', 'session_void']) assert.ok(gameAudit.some((row) => row.action === action));
      const output = JSON.stringify([adminAudit, gameAudit, errors.mock.calls.map(({ arguments: args }) => args),
        warnings.mock.calls.map(({ arguments: args }) => args)]);
      for (const privateValue of [teacher, phone, email, secretText, passwordText, adminCookie.split('=')[1], code, point.lat, point.lng]) {
        assert.equal(output.includes(String(privateValue)), false, 'audit and process logs contain only approved fields');
      }
    });
}

test('production only degrades position reports on Redis connection loss',
  { skip: !process.env.REDIS_TEST_URL, timeout: 20_000 }, async (t) => {
    const url = new URL(process.env.REDIS_TEST_URL);
    assert.equal(url.hostname, '127.0.0.1');
    url.pathname = '/13';
    const redis = createClient({ url: url.href, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
    redis.on('error', () => {});
    await redis.connect();
    t.after(() => { if (redis.isOpen) redis.destroy(); });
    const control = createClient({ url: url.href });
    control.on('error', () => {});
    await control.connect();
    t.after(() => control.destroy());
    // This database is dedicated to the temporary production test server.
    await control.flushDb();
    const app = await openApi(t, { secure: true, redis });
    const teacherLogin = '/api/teacher/login';
    for (let index = 1; index <= 20; index++) {
      const response = await app.request(teacherLogin, {
        body: { account: `failed-${index}`, password: '' }, headers: { 'X-Forwarded-For': `198.51.100.${index}` },
      });
      assert.equal(response.status, 401);
    }
    const limited = await app.request(teacherLogin, {
      body: { account: 'extra', password: '' }, headers: { 'X-Forwarded-For': '192.0.2.2' },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(limited.headers['cache-control'], 'no-store');

    app.setNow(activeTime);
    const cookie = await startTracking(app, cat);
    const adminCookie = await app.teacherCookie();
    const socket = await app.socket(cookie);
    for (let index = 0; index < 12; index++) {
      const response = await app.request('/api/preview/position', { body: {}, cookie });
      assert.equal(response.status, 400);
    }
    const rateError = once(socket, 'live:error', { signal: AbortSignal.timeout(4000) });
    socket.emit('live:position', { ...point, sessionId: evening.id });
    const [, retry] = await rateError;
    assert.equal(retry.code, 'RATE_LIMIT');
    assert.ok(retry.retryAfter > 0);

    const id = await redis.clientId();
    await control.sendCommand(['CLIENT', 'KILL', 'ID', String(id)]);
    const protectedRequests = [
      [teacherLogin, { account: teacher, password: passwordText }],
      ['/api/auth/login'],
      ['/api/auth/callback?code=withheld'],
      ['/api/auth/register', {}],
      ['/api/admin/dashboard', { eventDate: day }, adminCookie],
      ['/api/admin/export', { eventDate: day }, adminCookie],
      ['/api/preview/capture', { code: secretText }, cookie],
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const [path, body, session] of protectedRequests) {
        const response = await app.request(path, { body, cookie: session });
        assert.equal(response.status, 503, path.split('?')[0]);
        assert.deepEqual(response.json(), { code: 'RATE_UNAVAILABLE', message: '服务繁忙，请稍后重试' });
      }
    }
    const navigation = await app.request('/api/auth/callback', { headers: { Accept: 'text/html' } });
    assert.equal(navigation.status, 503);
    assert.match(navigation.headers['content-type'], /^text\/plain/);
    assert.equal(navigation.bytes.toString(), '服务繁忙，请稍后重试');
    const body = { ...point, sessionId: evening.id };
    assert.equal((await app.request('/api/preview/position', { body })).status, 401);
    const wrote = await app.request('/api/preview/position', { body, cookie });
    assert.equal(wrote.status, 200);
    assert.equal(wrote.json().lat, point.lat);
    app.setNow(activeTime + 5000);
    socket.emit('live:position', { ...body, lat: point.lat + 0.00001 });
    const until = AbortSignal.timeout(3000);
    while ((await app.positions.get(cat)).updated_at !== activeTime + 5000) await delay(20, undefined, { signal: until });
    assert.equal(socket.connected, true);
    assert.equal((await app.positions.get(cat)).lat, point.lat + 0.00001);
  });
