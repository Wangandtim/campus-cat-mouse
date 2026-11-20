import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SignJWT } from 'jose';
import { createConnection } from 'mysql2/promise';
import { createPreviewApi, createPreviewServices } from '../api.mjs';
import { createSessions } from '../auth/session.mjs';
import { openSqliteStore } from '../database.mjs';
import { eventId } from '../db/migrations.mjs';
import { openMysqlStore } from '../db/mysql.mjs';
import { createGame } from '../game.mjs';
import { sessionWindow } from '../rules.mjs';
import { firstEventDate, publishesAt, shiftDay, startsAt } from './common.mjs';
import { deliverOutbox } from './outbox.mjs';
import { createAdminService } from './service.mjs';
import { publishTop20, readSnapshot } from './top20.mjs';

const teacher = { kind: 'teacher', id: 'teacher-a' };
const day = firstEventDate;
const nextDay = shiftDay(day, 1);
const ids = Array.from({ length: 45 }, (_, n) => `student-${String(n).padStart(2, '0')}`.padEnd(32, '_'));
const loginPassword = 'only-used-in-admin-test';
const salt = randomBytes(16);
const passwordHash = `${salt.toString('base64url')}.${scryptSync(loginPassword, salt, 64,
  { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;

async function openTemporaryStores(t, mysql) {
  if (!mysql) {
    const directory = await mkdtemp(join(tmpdir(), 'campus-admin-sqlite-'));
    const filename = join(directory, 'admin.sqlite3');
    const stores = [];
    t.after(async () => {
      await Promise.all(stores.map((store) => store.close()));
      await rm(directory, { recursive: true, force: true });
    });
    stores.push(openSqliteStore(filename), openSqliteStore(filename));
    return stores;
  }
  const url = new URL(process.env.MYSQL_TEST_URL);
  const connection = await createConnection(url.href);
  const name = `campus_admin_test_${randomBytes(8).toString('hex')}`;
  const stores = [];
  await connection.query(`CREATE DATABASE \`${name}\``);
  t.after(async () => {
    try {
      await Promise.all(stores.map((store) => store.close()));
      await connection.query(`DROP DATABASE \`${name}\``);
    } finally {
      await connection.end();
    }
  });
  url.pathname = `/${name}`;
  stores.push(await openMysqlStore(url.href));
  stores.push(await openMysqlStore(url.href));
  return stores;
}

const count = async (store, table) => Number((await store.read((tx) => tx.get(`SELECT COUNT(*) AS n FROM ${table}`))).n);

async function seedStudents(store) {
  const { users } = store.tables;
  await store.transaction(async (tx) => {
    for (const [n, id] of ids.entries()) {
      await tx.run(`INSERT INTO ${users} (id, nickname, name, student_id, email, openid, gender, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'male', ?)`, id, `学生${n}`, `测试学生${n}`, `100${n}`, `student${n}@example.invalid`, id, startsAt(day) - 1);
      await tx.run('INSERT INTO event_registrations (event_id, user_id, created_at) VALUES (?, ?, ?)', eventId, id, startsAt(day) - 1);
    }
  });
}

async function seedRanking(store) {
  await store.transaction(async (tx) => {
    for (const stage of ['morning', 'evening']) await tx.ensureSession(`${day}:${stage}`);
    async function session(n, stage, meters, captures, minute, { state = 'settled', role = 'cat', gap = 0, late = false } = {}) {
      const { id, startsAt: start } = sessionWindow(day, stage);
      const required = stage === 'morning' ? 2000 : 3000;
      await tx.run(`INSERT INTO participation_sessions (event_id, session_id, player_id, role, gender,
        started_at, status, status_at, valid_meters, required_meters, max_seconds, completed_at, data_gap_seconds)
        VALUES (?, ?, ?, ?, 'male', ?, ?, ?, ?, ?, ?, ?, ?)`, eventId, id, ids[n], role, start, state, start, meters,
      required, 1020, start + (late ? 18 : 15) * 60_000, gap);
      for (let capture = 0; capture < captures; capture++) {
        await tx.run(`INSERT INTO captures (id, player_id, stage, mouse_id, zone_id, completed_at, meters, awarded,
          session_id, mouse_player_id, grid_id) VALUES (?, ?, ?, 3, 'test-zone', ?, 100, 10, ?, ?, 'test-grid')`,
        randomUUID(), ids[n], stage, start + minute * 60_000 - captures + capture + 1, id, ids[capture]);
      }
    }
    for (const [n, meters, final] of [[13, 5300, 24], [14, 5300, 23], [15, 5300, 23], [16, 5500, 25]]) {
      await session(n, 'morning', meters - 3100, 2, 30, { gap: n === 14 ? 40 : 0 });
      await session(n, 'evening', 3100, 1, final);
    }
    await session(17, 'morning', 2300, 1, 35);
    await session(17, 'evening', 7000, 0, 40);
    for (let n = 18; n <= 38; n++) await session(n, 'morning', 2200, 1, 34);
    await session(39, 'evening', 9000, 5, 40, { state: 'void' });
    await session(40, 'evening', 9000, 5, 40, { late: true });
    await session(41, 'evening', 9000, 5, 40, { role: 'mouse' });
    await session(42, 'evening', 9000, 0, 40);
    await session(43, 'evening', 2999, 5, 40);
    await tx.lockSettlement(`${day}:morning`);
    await tx.run('UPDATE session_settlements SET settled_at = ? WHERE event_id = ? AND session_id = ?',
      publishesAt(day) - 300_000, eventId, `${day}:morning`);
  });
}

async function exerciseHttp(t, store, clock, entries) {
  const studentKey = randomBytes(32);
  const teacherKey = randomBytes(32);
  const { game, positions } = createPreviewServices(store, clock);
  const api = createPreviewApi({
    CAMPUS_AUTH_MODE: 'mock', NODE_ENV: 'test', CAMPUS_ROSTER_CSV: '',
    CAMPUS_JWT_SECRET: studentKey.toString('base64url'), CAMPUS_TEACHER_ALLOWLIST: teacher.id,
    CAMPUS_TEACHER_PASSWORD_HASHES: JSON.stringify({ [teacher.id]: passwordHash }),
    CAMPUS_TEACHER_JWT_SECRET: teacherKey.toString('base64url'),
  }, game, positions);
  const server = createServer(api).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie, inputOrigin = origin) => fetch(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(inputOrigin ? { Origin: inputOrigin } : {}),
      ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  const cookieFor = async (id) => {
    let cookie;
    const res = { appendHeader: (_header, value) => { cookie = value.split(';')[0]; } };
    await createSessions(studentKey, 'urn:campus:mock', false, clock).write(res, 'player', id);
    return cookie;
  };
  const studentCookie = await cookieFor(entries[1].userId);
  const outsiderCookie = await cookieFor(ids[44]);
  const login = { account: teacher.id, password: loginPassword };
  assert.equal((await post('/api/teacher/login', login, null, 'https://other.invalid')).status, 403);
  assert.equal((await post('/api/teacher/login', { ...login, password: 'wrong' })).status, 401);
  const response = await post('/api/teacher/login', login);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^campus_teacher=.*; Path=\/; HttpOnly; SameSite=Lax;/);
  const teacherCookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/admin/session', {}, teacherCookie, null)).status, 403);
  assert.equal((await post('/api/admin/session', {}, teacherCookie, 'https://other.invalid')).status, 403);
  for (const path of ['session', 'dashboard', 'students', 'assignments', 'interviews', 'anything']) {
    assert.equal((await post(`/api/admin/${path}`, {}, studentCookie)).status, 401);
  }
  assert.equal((await post('/api/admin/session', {}, studentCookie.replace('campus_session', 'campus_teacher'))).status, 401);
  const roleCookie = await new SignJWT({ role: 'student' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('campus-admin').setAudience('campus-teacher').setSubject(teacher.id)
    .setIssuedAt(Math.floor(clock() / 1000)).setExpirationTime(Math.floor(clock() / 1000) + 600).sign(teacherKey);
  assert.equal((await post('/api/admin/session', {}, `campus_teacher=${roleCookie}`)).status, 401);
  const dashboard = await (await post('/api/admin/dashboard', {}, teacherCookie)).json();
  assert.deepEqual(dashboard.snapshot.entries.map(({ userId }) => userId), entries.map(({ userId }) => userId));
  assert.deepEqual(await (await post('/api/preview/interview', {}, studentCookie)).json(), { interview: { eventDate: day } });
  assert.deepEqual(await (await post('/api/preview/interview', {}, outsiderCookie)).json(), { interview: null });
  assert.equal((await post('/api/preview/interview', { userId: entries[0].userId }, studentCookie)).status, 403);
  assert.equal((await post('/api/preview/interview/decline', { eventDate: day, userId: entries[0].userId }, studentCookie)).status, 403);
  assert.equal((await post('/api/preview/interview/decline', { eventDate: day, status: 'CONFIRMED' }, studentCookie)).status, 403);
  assert.equal((await post('/api/preview/interview/decline', { eventDate: day }, teacherCookie)).status, 401);
  assert.deepEqual(await (await post('/api/preview/interview/decline', { eventDate: day }, studentCookie)).json(), { status: 'DECLINED' });
  assert.deepEqual(await (await post('/api/preview/interview', {}, studentCookie)).json(), { interview: null });
}

for (const mysql of [false, true]) {
  test(`P0-5b ${mysql ? 'MySQL' : 'SQLite'}`, { skip: mysql && !process.env.MYSQL_TEST_URL }, async (t) => {
    const [store, other] = await openTemporaryStores(t, mysql);
    const { users } = store.tables;
    await seedStudents(store);
    let now = startsAt(day) - 1;
    const clock = () => now;
    const admin = createAdminService(store, clock);
    const worker = createAdminService(other, clock);
    const mice = () => store.read(async (tx) => (await tx.all(`SELECT id FROM ${users} WHERE role = 'mouse' ORDER BY id`)).map(({ id }) => id));
    const change = (entry, status) => admin.transition(teacher, { eventDate: day, userId: entry.userId, status });

    await t.test('concurrent first-day limit, duplicates, replacement audit and 06:30 activation', async () => {
      const requests = ids.slice(0, 11).map((userId, n) => (n % 2 ? worker : admin).assign(teacher, { eventDate: day, userId }));
      const results = await Promise.allSettled(requests);
      assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 10);
      assert.deepEqual(results.filter(({ status }) => status === 'rejected').map(({ reason }) => reason.code), ['MOUSE_LIMIT']);
      const { assignment: { rows } } = await admin.dashboard({ assignmentDate: day });
      await assert.rejects(admin.assign(teacher, { eventDate: day, userId: rows[0].userId }), { code: 'DUPLICATE_MOUSE' });
      const replacement = { eventDate: day, userId: ids[11], replaceUserId: rows[0].userId, reason: '名单调整' };
      await assert.rejects(async () => admin.assign(teacher, { ...replacement, reason: '' }), { code: 'ASSIGNMENT_REASON' });
      await admin.assign(teacher, replacement);
      const audit = await store.read((tx) => tx.get("SELECT actor_id, details, created_at FROM admin_audit WHERE action = 'roster.replaced'"));
      assert.equal(audit.actor_id, teacher.id);
      assert.equal(audit.created_at, now);
      assert.equal((typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details).reason, '名单调整');
      await admin.activate();
      assert.deepEqual(await mice(), []);
      now = startsAt(day);
      await Promise.all([admin.activate(), worker.activate()]);
      assert.deepEqual(await mice(), rows.slice(1).map(({ userId }) => userId).concat(ids[11]).sort());
      await assert.rejects(admin.assign(teacher, { eventDate: day, userId: ids[0] }), { code: 'ROSTER_LOCKED' });
    });

    let entries;
    await t.test('settlement gate, ranked daily snapshot, data gap and immutable delivery data', async () => {
      await seedRanking(store);
      now = publishesAt(day) - 1;
      assert.equal(await publishTop20(store, day, now), 'early');
      now++;
      const waiting = [];
      const sending = createAdminService(store, clock, () => assert.fail('mail sent before settlement'));
      await sending.runJobs((date) => waiting.push(date));
      assert.deepEqual(waiting, [day]);
      assert.equal(await count(store, 'top20_snapshots'), 0);
      assert.equal(await count(store, 'email_outbox'), 0);
      await store.transaction(async (tx) => {
        await tx.lockSettlement(`${day}:evening`);
        await tx.run('UPDATE session_settlements SET settled_at = ? WHERE event_id = ? AND session_id = ?', now, eventId, `${day}:evening`);
      });
      const publication = await Promise.all([publishTop20(store, day, now), publishTop20(other, day, now)]);
      assert.deepEqual(publication.sort(), ['existing', 'published']);
      ({ entries } = await store.read((tx) => readSnapshot(tx, day)));
      const expected = [16, 14, 15, 13, 17, ...Array.from({ length: 15 }, (_, n) => n + 18)];
      assert.deepEqual(entries.map(({ userId }) => userId), expected.map((n) => ids[n]));
      assert.equal(entries[0].captures, 3);
      assert.equal(entries[0].validMeters, 5500);
      assert.equal(entries[1].achievedAt, sessionWindow(day, 'evening').startsAt + 23 * 60_000);
      assert.equal(entries[1].dataGap, true);
      assert.equal(entries[4].validMeters, 2300);
      assert.equal(await count(store, 'email_outbox'), 20);
      await store.transaction((tx) => tx.run('UPDATE participation_sessions SET valid_meters = 9900 WHERE player_id = ?', ids[13]));
      assert.equal(await publishTop20(other, day, now + 1), 'existing');
      assert.deepEqual((await store.read((tx) => readSnapshot(tx, day))).entries, entries);
      for (const sql of ['UPDATE top20_snapshots SET entries = ?', 'DELETE FROM top20_snapshots']) {
        await assert.rejects(store.transaction((tx) => tx.run(sql, ...(sql.includes('?') ? ['[]'] : []))), /immutable/);
      }
    });

    await t.test('mock outbox leases, retry and stable idempotency keys across workers', async () => {
      const delivered = new Map();
      const attempts = new Map();
      const retryKey = `${eventId}/${day}/${entries[0].userId}/top20_interview`;
      async function mockSend(message) {
        const { idempotencyKey } = message;
        const previous = delivered.get(idempotencyKey);
        if (previous) assert.deepEqual(message, previous);
        else delivered.set(idempotencyKey, message);
        attempts.set(idempotencyKey, (attempts.get(idempotencyKey) ?? 0) + 1);
        if (idempotencyKey === retryKey && !previous) throw new Error('mock timeout after acceptance');
      }
      await Promise.all([deliverOutbox(store, mockSend, clock), deliverOutbox(other, mockSend, clock)]);
      assert.equal(delivered.size, 20);
      assert.ok([...attempts.values()].every((n) => n === 1));
      const failure = () => store.read((tx) => tx.get('SELECT status, attempts FROM email_outbox WHERE user_id = ?', entries[0].userId));
      assert.deepEqual({ ...await failure() }, { status: 'failed', attempts: 1 });
      now += 29_999;
      await deliverOutbox(store, mockSend, clock);
      assert.equal(attempts.get(retryKey), 1);
      now++;
      await Promise.all([deliverOutbox(store, mockSend, clock), deliverOutbox(other, mockSend, clock)]);
      assert.equal(attempts.get(retryKey), 2);
      assert.equal(delivered.size, 20);
      assert.equal(delivered.get(retryKey).rank, 1);
      assert.deepEqual({ ...await failure() }, { status: 'sent', attempts: 2 });
    });

    await t.test('teacher credentials, exact Origin and student invitation ownership', async (subtest) => {
      await exerciseHttp(subtest, store, clock, entries);
    });

    await t.test('state machine, decline and no-show fill by snapshot rank at next 06:30', async () => {
      await change(entries[0], 'NO_SHOW');
      await change(entries[2], 'WAITLISTED');
      await assert.rejects(async () => admin.transition({ kind: 'student', id: entries[2].userId }, {
        eventDate: day, userId: entries[2].userId, status: 'CONFIRMED',
      }), { code: 'INTERVIEW_FORBIDDEN' });
      await change(entries[2], 'CONFIRMED');
      await assert.rejects(change(entries[0], 'CONFIRMED'), { code: 'INTERVIEW_STATE' });
      await assert.rejects(change(entries[1], 'CONFIRMED'), { code: 'INTERVIEW_STATE' });
      for (const entry of entries.slice(3, 14).reverse()) await change(entry, 'CONFIRMED');
      const { assignment } = await admin.dashboard({ assignmentDate: nextDay });
      assert.deepEqual(assignment.rows.map(({ userId }) => userId), entries.slice(2, 12).map(({ userId }) => userId));
      const replace = { eventDate: nextDay, userId: entries[12].userId, replaceUserId: entries[4].userId, reason: '教师调整' };
      await assert.rejects(admin.assign(teacher, { ...replace, userId: entries[0].userId }), { code: 'TOP20_REQUIRED' });
      await admin.assign(teacher, replace);
      const previous = await mice();
      now = startsAt(nextDay) - 1;
      await Promise.all([admin.activate(), worker.activate()]);
      assert.deepEqual(await mice(), previous);
      now++;
      await Promise.all([admin.activate(), worker.activate()]);
      assert.deepEqual(await mice(), entries.slice(2, 12).map(({ userId }) => userId)
        .filter((id) => id !== replace.replaceUserId).concat(replace.userId).sort());
      await assert.rejects(change(entries[19], 'CONFIRMED'), { code: 'INTERVIEW_CLOSED' });
      const audits = await store.read((tx) => tx.all("SELECT actor_kind, user_id FROM admin_audit WHERE action = 'interview.changed'"));
      assert.ok(audits.some((row) => row.actor_kind === 'student' && row.user_id === entries[1].userId));
      assert.ok(audits.some((row) => row.actor_kind === 'teacher' && row.user_id === entries[0].userId));
    });

    await t.test('P0-5a settles empty sessions and the immutable empty snapshot is published once', async () => {
      now = publishesAt(nextDay);
      await admin.prepareSettlementDays(now);
      await createGame(store, clock).settleDue(now);
      assert.equal(await publishTop20(store, nextDay, now), 'published');
      assert.equal(await publishTop20(other, nextDay, now), 'existing');
      assert.deepEqual((await store.read((tx) => readSnapshot(tx, nextDay))).entries, []);
      const insert = mysql ? 'REPLACE INTO' : 'INSERT OR REPLACE INTO';
      await assert.rejects(store.transaction((tx) => tx.run(`${insert} top20_snapshots (event_id, event_date, entries, created_at)
        VALUES (?, ?, ?, ?)`, eventId, nextDay, '[]', now + 1)), /immutable/);
      assert.equal(await count(store, 'top20_snapshots'), 2);
      assert.equal(await count(store, 'email_outbox'), 20);
    });
  });
}
