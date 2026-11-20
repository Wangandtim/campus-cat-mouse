import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConnection } from 'mysql2/promise';
import { io as connect } from 'socket.io-client';
import { createPreviewApi, createPreviewServices } from '../api.mjs';
import { openSqliteStore } from '../database.mjs';
import { eventId } from '../db/migrations.mjs';
import { openMysqlStore } from '../db/mysql.mjs';
import { attachLivePositions } from '../live/positions.mjs';
import { createRateLimiter } from '../security/rate-limit.mjs';
import { createWechatProvider } from './providers.mjs';
import { parseRoster } from './roster.mjs';

const mysqlUrl = process.env.MYSQL_TEST_URL;
const school = '西安欧亚学院';
const secret = randomBytes(32).toString('base64url');
const mockEnv = { NODE_ENV: 'test', CAMPUS_AUTH_MODE: 'mock', CAMPUS_JWT_SECRET: secret };
const initialTime = Date.parse('2026-11-23T17:45:00+08:00');
const callbackPath = '/api/auth/callback';

function student(number) {
  return {
    school, name: `虚构学生${number}`, studentNo: `TEST-${number}`,
    grade: '测试年级', college: '测试学院', className: '测试班',
    phone: '00000000000', email: `student${number}@example.invalid`, gender: 'female',
  };
}

function cookieOf(response, name) {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
}

async function runHttp(t, store, env = mockEnv, redis) {
  let now = initialTime;
  const clock = () => now;
  const { game, liveGame, positions } = createPreviewServices(store, clock);
  const server = createServer((req, res) => void api(req, res));
  const { io, profileChanged } = attachLivePositions(server, { game: liveGame, positions, clock });
  const api = createPreviewApi(env, game, positions, profileChanged, createRateLimiter({ env, redis, clock }));
  t.after(() => io.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, body, origin = base, headers } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(body !== undefined && { 'Content-Type': 'application/json', ...(origin && { Origin: origin }) }),
        ...headers,
      },
    }, async (res) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headersDistinct)) {
          for (const entry of value) headers.append(name, entry);
        }
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  async function start(account) {
    const res = await request(`/api/auth/login?account=${account}`);
    assert.equal(res.status, 303);
    const cookie = cookieOf(res, 'campus_state');
    assert.match(cookie, /; HttpOnly; SameSite=Lax/);
    assert.match(cookie, /; Max-Age=600(?:;|$)/);
    assert.doesNotMatch(cookie, /; Secure/);
    return { callback: new URL(res.headers.get('Location'), base), stateCookie: cookie.split(';')[0] };
  }
  async function login(account) {
    const { callback, stateCookie } = await start(account);
    const res = await request(callback.pathname + callback.search, { cookie: stateCookie });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), '/');
    return cookieOf(res, 'campus_session').split(';')[0];
  }
  return {
    request, start, login,
    advance(ms) { now += ms; },
    get now() { return now; },
    register: (cookie, body, origin) => request('/api/auth/register', { cookie, body, origin }),
    async handshake(cookie, event = 'connect_error') {
      const socket = connect(base, {
        autoConnect: false, forceNew: true, transports: ['websocket'], reconnection: false,
        ...(cookie && { extraHeaders: { Cookie: cookie } }),
      });
      try {
        const outcome = once(socket, event, { signal: AbortSignal.timeout(3000) });
        socket.connect();
        return (await outcome)[0];
      } finally {
        socket.disconnect();
      }
    },
  };
}

async function errorCode(res, status, code) {
  assert.equal(res.status, status);
  assert.equal((await res.json()).code, code);
}

async function exerciseAuth(t, store) {
  const app = await runHttp(t, store);
  const session = async (cookie) => (await (await app.request('/api/auth/session', { cookie })).json()).status;
  const gameState = (cookie) => app.request('/api/preview/state', { cookie });

  await t.test('binds state to the Cookie, stores only its hash and atomically rejects replays', async () => {
    const first = await app.start('oauth-state');
    const other = await app.start('oauth-other');
    const path = first.callback.pathname + first.callback.search;
    const hash = createHash('sha256').update(first.callback.searchParams.get('state')).digest('hex');
    const row = await store.read((db) => db.get('SELECT expires_at FROM oauth_states WHERE state_hash = ?', hash));
    assert.equal(row.expires_at, app.now + 600_000);
    await errorCode(await app.request(path, { cookie: other.stateCookie }), 400, 'OAUTH_STATE');
    await errorCode(await app.request(`${path}&redirect_uri=https://example.invalid`, { cookie: first.stateCookie }),
      400, 'OAUTH_REDIRECT');
    const race = await Promise.all([1, 2].map(() => app.request(path, { cookie: first.stateCookie })));
    assert.deepEqual(race.map((res) => res.status).sort(), [303, 400]);
    await errorCode(race.find((res) => res.status === 400), 400, 'OAUTH_STATE');
    assert.equal(await store.read((db) => db.get('SELECT 1 FROM oauth_states WHERE state_hash = ?', hash)), undefined);

    const expired = await app.start('oauth-expired');
    app.advance(600_000);
    await errorCode(await app.request(expired.callback.pathname + expired.callback.search, { cookie: expired.stateCookie }),
      400, 'OAUTH_STATE');
    await errorCode(await app.request('/api/auth/login?next=https://example.invalid'), 400, 'OAUTH_REDIRECT');
  });

  await t.test('distinguishes school, roster and name errors and rejects cross-origin POSTs', async () => {
    const pending = await app.login('registration-errors');
    assert.equal(await session(pending), 'registration');
    await errorCode(await gameState(pending), 401, 'AUTH');
    await errorCode(await app.register(pending, { ...student(1), school: '虚构外校' }), 422, 'EXTERNAL_SCHOOL');
    await errorCode(await app.register(pending, { ...student(1), studentNo: 'TEST-EXTERNAL' }), 422, 'EXTERNAL_SCHOOL');
    await errorCode(await app.register(pending, { ...student(1), studentNo: 'TEST-404' }), 422, 'STUDENT_NOT_FOUND');
    await errorCode(await app.register(pending, { ...student(1), name: '姓名错误' }), 422, 'NAME_MISMATCH');
    await errorCode(await app.register(pending, { ...student(1), gender: 'unknown' }), 400, 'GENDER');
    await errorCode(await app.register(pending, student(1), 'https://example.invalid'), 403, 'ORIGIN');
    await errorCode(await app.register(pending, student(1), null), 403, 'ORIGIN');
  });

  let playerCookie;
  await t.test('persists registration fields and identifies the same player on later WeChat logins', async () => {
    const pending = await app.login('returning-player');
    const res = await app.register(pending, { ...student(1), school: `　${school} `, name: '　虚构学生１ ' });
    assert.equal(res.status, 201);
    const jwtCookie = cookieOf(res, 'campus_session');
    assert.match(jwtCookie, /; HttpOnly; SameSite=Lax; Max-Age=\d+/);
    assert.doesNotMatch(jwtCookie, /; Secure/);
    const first = jwtCookie.split(';')[0];
    const profile = await store.read((db) => db.get(`SELECT name, student_id, grade, college, class_name, phone, email, role, gender
      FROM ${store.tables.users} WHERE student_id = ?`, 'TEST-1'));
    const expected = student(1);
    assert.deepEqual({ ...profile }, {
      name: expected.name, student_id: expected.studentNo, grade: expected.grade, college: expected.college,
      class_name: expected.className, phone: expected.phone, email: expected.email, role: 'cat', gender: 'female',
    });
    playerCookie = await app.login('returning-player');
    assert.equal(await session(playerCookie), 'player');
    const firstData = await (await gameState(first)).json();
    const secondData = await (await gameState(playerCookie)).json();
    assert.deepEqual(firstData.profile, secondData.profile);
    assert.equal(secondData.profile.role, 'cat');
    await errorCode(await app.request('/api/preview/profile', { cookie: playerCookie, body: { role: 'mouse' } }), 403, 'ROLE');
    for (const stage of ['morning', 'evening']) {
      const res = await app.request('/api/preview/profile', { cookie: playerCookie, body: { stage } });
      assert.equal((await res.json()).stage.id, stage);
    }
    await errorCode(await app.register(playerCookie, student(1)), 409, 'ALREADY_REGISTERED');
    const registrations = await store.read((db) => db.all(`SELECT r.user_id, r.event_id FROM event_registrations r
      JOIN ${store.tables.users} u ON u.id = r.user_id WHERE u.student_id = ?`, 'TEST-1'));
    assert.equal(registrations.length, 1);
    const [{ user_id: userId, event_id: savedEvent }] = registrations;
    assert.equal(savedEvent, eventId);
    await assert.rejects(store.transaction((db) => db.run(`INSERT INTO event_registrations
      (user_id, event_id, created_at) VALUES (?, ?, ?)`, userId, eventId, app.now)));
  });

  await t.test('returning students complete an unknown gender on their own account before participation', async () => {
    await store.transaction((tx) => tx.run(`UPDATE ${store.tables.users} SET gender = 'unknown' WHERE student_id = ?`, 'TEST-1'));
    const status = await app.request('/api/auth/session', { cookie: playerCookie });
    assert.equal((await status.json()).needsGender, true);
    await errorCode(await app.request('/api/preview/tracking', { cookie: playerCookie, body: { active: true } }), 403, 'GENDER');
    await errorCode(await app.request('/api/auth/gender', { body: { gender: 'male' } }), 401, 'AUTH');
    const res = await app.request('/api/auth/gender', { cookie: playerCookie, body: { gender: 'female' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).needsGender, false);
    await errorCode(await app.request('/api/auth/gender', { cookie: playerCookie, body: { gender: 'male' } }), 409, 'GENDER_EXISTS');
    assert.equal((await app.request('/api/preview/tracking', { cookie: playerCookie, body: { active: true } })).status, 200);
  });

  await t.test('allows just one concurrent binding per openid and per student number', async () => {
    const sameOpenId = await Promise.all([app.login('same-openid'), app.login('same-openid')]);
    const sameStudent = await Promise.all([app.login('first-openid'), app.login('second-openid')]);
    for (const [cookies, students, conflict] of [
      [sameOpenId, [student(2), student(3)], 'OPENID_BOUND'],
      [sameStudent, [student(4), student(4)], 'STUDENT_BOUND'],
    ]) {
      const rs = await Promise.all(cookies.map((cookie, i) => app.register(cookie, students[i])));
      assert.deepEqual(rs.map((res) => res.status).sort(), [201, 409]);
      await errorCode(rs.find((res) => res.status === 409), 409, conflict);
    }
    const { total: users } = await store.read((db) => db.get(`SELECT COUNT(*) AS total FROM ${store.tables.users} WHERE openid IS NOT NULL`));
    const { total: entries } = await store.read((db) => db.get('SELECT COUNT(*) AS total FROM event_registrations'));
    assert.equal(users, 3);
    assert.equal(entries, 3);
  });

  await t.test('HTTP and Socket.IO reject absent, tampered, unsecured and expired JWTs', async () => {
    assert.equal((await app.handshake(playerCookie, 'live:ready')).role, 'cat');
    const [header, payload, sig] = playerCookie.slice('campus_session='.length).split('.');
    const tampered = `campus_session=${header}.${payload}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    const none = `campus_session=${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    for (const cookie of [undefined, tampered, none]) {
      await errorCode(await gameState(cookie), 401, 'AUTH');
      assert.ok(await app.handshake(cookie) instanceof Error);
    }
    const { exp, iat, jti } = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.ok(exp > iat && jti);
    app.advance(exp * 1000 - app.now);
    await errorCode(await gameState(playerCookie), 401, 'AUTH');
    assert.ok(await app.handshake(playerCookie) instanceof Error);
    assert.equal(await session(playerCookie), 'anonymous');
  });

  await t.test('logout checks Origin and clears the browser session and state Cookies', async () => {
    const cookie = await app.login('returning-player');
    await errorCode(await app.request('/api/auth/logout', { cookie, body: {}, origin: 'https://example.invalid' }), 403, 'ORIGIN');
    const res = await app.request('/api/auth/logout', { cookie, body: {} });
    assert.equal(res.status, 200);
    assert.match(cookieOf(res, 'campus_session'), /^campus_session=; .*Max-Age=0/);
    assert.match(cookieOf(res, 'campus_state'), /^campus_state=; .*Max-Age=0/);
  });
}

test('P0-2 with SQLite', { timeout: 30000 }, async (t) => {
  const store = openSqliteStore(':memory:');
  t.after(store.close);
  await exerciseAuth(t, store);
});

test('P0-2 with a disposable MySQL 8 schema', { skip: !mysqlUrl, timeout: 60000 }, async (t) => {
  const url = new URL(mysqlUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const schema = `campus_auth_${randomBytes(8).toString('hex')}`;
  const admin = await createConnection(url.href);
  let store;
  t.after(async () => {
    await store?.close();
    await admin.query(`DROP DATABASE IF EXISTS ${schema}`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${schema}`);
  url.pathname = `/${schema}`;
  await openMysqlStore(url.href).then((initial) => initial.close());
  store = await openMysqlStore(url.href);
  await exerciseAuth(t, store);
});

test('production forbids fallback and fixes the HTTPS WeChat callback', async (t) => {
  const store = openSqliteStore(':memory:');
  t.after(store.close);
  const { game, positions } = createPreviewServices(store);
  for (const mode of ['demo', 'mock']) {
    assert.throws(() => createPreviewApi({ ...mockEnv, NODE_ENV: 'production', CAMPUS_AUTH_MODE: mode }, game, positions),
      /production/);
  }
  assert.throws(() => createPreviewApi({ ...mockEnv, CAMPUS_JWT_SECRET: 'short' }, game, positions), /32 字节/);
  const origin = 'https://campus.example.invalid';
  const prod = { ...mockEnv, NODE_ENV: 'production', CAMPUS_AUTH_MODE: 'wechat', CAMPUS_PUBLIC_ORIGIN: origin };
  assert.throws(() => createPreviewApi(prod, game, positions), /WECHAT_APP_ID/);
  const configured = { ...prod, WECHAT_APP_ID: 'wx-fake-app', WECHAT_APP_SECRET: 'fictional-app-secret' };
  assert.throws(() => createPreviewApi({ ...configured, WECHAT_REDIRECT_ALLOWLIST: 'https://other.example.invalid/' }, game, positions),
    /WECHAT_REDIRECT_ALLOWLIST/);
  const dir = mkdtempSync(join(tmpdir(), 'campus-p02-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fictional.csv');
  writeFileSync(path, 'school,student_no,name\n西安欧亚学院,TEST-1,虚构学生1\n');
  const readyRedis = { isReady: true, withCommandOptions: () => ({ ping: async () => 'PONG' }) };
  const app = await runHttp(t, store, { ...configured, CAMPUS_ROSTER_CSV: path,
    WECHAT_REDIRECT_ALLOWLIST: `${origin}${callbackPath}` }, readyRedis);
  const headers = { Host: new URL(origin).host, 'X-Forwarded-Proto': 'https' };
  await errorCode(await app.request('/api/auth/login', { headers: { ...headers, 'X-Forwarded-Proto': 'http' } }),
    403, 'HTTPS_REQUIRED');
  const denied = await app.request('/api/auth/login', { headers: { ...headers, Host: 'other.example.invalid' } });
  assert.equal(denied.status, 403);
  const res = await app.request('/api/auth/login', { headers });
  assert.equal(res.status, 303);
  const auth = new URL(res.headers.get('Location'));
  assert.equal(auth.origin, 'https://open.weixin.qq.com');
  assert.equal(auth.searchParams.get('redirect_uri'), `${origin}${callbackPath}`);
  assert.equal(auth.searchParams.get('scope'), 'snsapi_base');
  assert.match(cookieOf(res, '__Host-campus_state'), /; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
});

test('roster imports are all-or-nothing and preserve only row numbers in errors', () => {
  assert.throws(() => parseRoster(Buffer.from([0xff, 0xfe, 0x00])), /UTF-8/);
  assert.throws(() => parseRoster(Buffer.from('student_no,name\nTEST-1,虚构学生1\n')), /表头.*school/);
  const header = '\uFEFFschool,student_no,name\r\n';
  const row = '西安欧亚学院,TEST-1,虚构学生1\r\n';
  assert.throws(() => parseRoster(Buffer.from(header + row + row)), /第 3 行与第 2 行的学号重复/);
  const verify = parseRoster(Buffer.from(header + row));
  assert.equal(verify({ ...student(1), name: '　虚构学生１ ' }).name, '虚构学生1');
});

test('WeChat exchanges only the OAuth code server-side and extracts the openid', async () => {
  const options = { appId: 'wx-fake-app', secret: 'fictional-app-secret', redirectUri: 'https://campus.example.invalid/api/auth/callback' };
  const provider = createWechatProvider(options, async (url, requestOptions) => {
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/oauth2/access_token');
    assert.equal(url.searchParams.get('code'), 'fictional-code');
    assert.equal(url.searchParams.get('secret'), options.secret);
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(requestOptions.redirect, 'error');
    return Response.json({ openid: 'fake-openid', access_token: 'fictional-token' });
  });
  assert.equal(await provider.exchange('fictional-code'), 'fake-openid');
  const rejected = createWechatProvider(options, async () => Response.json({ errcode: 40029, errmsg: 'internal' }));
  await assert.rejects(rejected.exchange('fictional-code'), { code: 'OAUTH_PROVIDER' });
});
