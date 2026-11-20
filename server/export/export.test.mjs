import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { createConnection } from 'mysql2/promise';
import { firstEventDate, shiftDay } from '../admin/common.mjs';
import { createPreviewApi, createPreviewServices } from '../api.mjs';
import { createSessions } from '../auth/session.mjs';
import { openSqliteStore } from '../database.mjs';
import { eventId } from '../db/migrations.mjs';
import { openMysqlStore } from '../db/mysql.mjs';
import { sessionWindow } from '../rules.mjs';
import { exportRootName } from '../security/export-cleanup.mjs';

const day = shiftDay(firstEventDate, 1);
const tomorrow = shiftDay(day, 1);
const morning = sessionWindow(day, 'morning');
const evening = sessionWindow(day, 'evening');
const todayMidnight = Date.parse(`${day}T00:00:00+08:00`);
const clock = () => evening.startsAt + 60_000;
const longClassName = '甲'.repeat(29) + '🐈甲乙?/\\';
const teachers = 'export-test';
const password = 'only-used-in-export-test';
const salt = randomBytes(16);
const passwordHash = `${salt.toString('base64url')}.${scryptSync(password, salt, 64,
  { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;

async function openStore(t, mysql) {
  if (!mysql) {
    const store = openSqliteStore(':memory:');
    t.after(store.close);
    return store;
  }
  const url = new URL(process.env.MYSQL_TEST_URL);
  const connection = await createConnection(url.href);
  const database = `campus_export_test_${randomBytes(8).toString('hex')}`;
  await connection.query(`CREATE DATABASE \`${database}\``);
  let store;
  t.after(async () => {
    try {
      await store?.close();
      await connection.query(`DROP DATABASE \`${database}\``);
    } finally {
      await connection.end();
    }
  });
  url.pathname = `/${database}`;
  store = await openMysqlStore(url.href);
  return store;
}

async function insertStudents(store, profiles) {
  const { users } = store.tables;
  await store.transaction(async (tx) => {
    for (let offset = 0; offset < profiles.length; offset += 100) {
      const batch = profiles.slice(offset, offset + 100);
      await tx.run(`INSERT INTO ${users}
        (id, openid, nickname, name, student_id, grade, college, class_name, phone, email, created_at)
        VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, ...batch.flatMap((profile) => [
        profile.id, profile.unbound ? null : profile.id, '测试号', profile.name, profile.id, profile.grade ?? '2026',
        profile.college ?? '信息学院', profile.className ?? '计科[1]班', profile.phone ?? '00123456789',
        profile.email ?? '0001@example.invalid', todayMidnight - 1,
      ]));
      const registered = batch.filter(({ unregistered }) => !unregistered);
      if (registered.length) await tx.run(`INSERT INTO event_registrations (event_id, user_id, created_at)
        VALUES ${registered.map(() => '(?, ?, ?)').join(', ')}`,
      ...registered.flatMap(({ id, registeredAt }) => [eventId, id, registeredAt ?? todayMidnight]));
    }
  });
}

async function seedReport(store) {
  await insertStudents(store, [
    { id: '00001', name: '示例甲' },
    { id: '00002', name: '\u0001=1+1', grade: '-2026', college: '商学院', phone: '+0012', email: '@sample.invalid' },
    { id: '00003', name: '示例乙', className: longClassName },
    { id: '00004', name: '示例&丙' },
    { id: '00005', name: '次日报名', registeredAt: Date.parse(`${tomorrow}T00:00:00+08:00`) },
    { id: '00006', name: '未报名', unregistered: true },
    { id: '00007', name: '未实名', unbound: true },
  ]);
  await store.transaction(async (tx) => {
    await tx.ensureSession(morning.id);
    await tx.ensureSession(evening.id);
    async function participate(id, session, status, meters, { gap = 0, gapStarted = null } = {}) {
      await tx.run(`INSERT INTO participation_sessions (event_id, session_id, player_id, role, gender,
        started_at, status, status_at, valid_meters, data_gap_seconds, gap_started_at)
        VALUES (?, ?, ?, 'cat', 'male', ?, ?, ?, ?, ?, ?)`,
      eventId, session.id, id, session.startsAt, status, session.startsAt, meters, gap, gapStarted);
    }
    async function capture(id, mouseId, stage, session, award, seconds) {
      await tx.run(`INSERT INTO captures (id, player_id, stage, mouse_id, zone_id, completed_at, meters, awarded,
        session_id, mouse_player_id, grid_id) VALUES (?, ?, ?, 1, 'test-zone', ?, 100, ?, ?, ?, 'test-grid')`,
      randomUUID(), id, stage, session.startsAt + seconds * 1000, award, session.id, mouseId);
    }
    await participate('00001', morning, 'settled', 2150.5, { gap: 32 });
    await participate('00001', evening, 'void', 2000);
    await participate('00002', evening, 'active', 700, { gapStarted: evening.startsAt });
    await participate('00003', morning, 'settled', 2000);
    await capture('00001', '00003', 'morning', morning, 10, 10);
    await capture('00001', '00002', 'evening', evening, 10, 25);
    await capture('00002', '00001', 'evening', evening, 10, 20);
    await capture('00002', '00003', 'evening', evening, 10, 30);
    for (const [id, stage, session, source, amount] of [
      ['00001', 'morning', morning, 'capture', 10],
      ['00001', 'morning', morning, 'mileage', 1],
      ['00001', 'morning', morning, 'redemption', -6],
      ['00001', 'evening', evening, 'capture', 10],
      ['00001', 'evening', evening, 'capture_reversal', -10],
      ['00002', 'evening', evening, 'capture', 20],
      ['00004', 'evening', evening, 'capture', 10],
    ]) await tx.addPoints(randomUUID(), id, stage, source, amount, session.startsAt, session.id);
  });
}

const readText = (text) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);

function readWorkbook(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const parts = new Map();
  let entry = bytes.readUInt32LE(end + 16);
  for (let n = 0; n < bytes.readUInt16LE(end + 10); n++) {
    assert.equal(bytes.readUInt32LE(entry), 0x02014b50);
    const nameSize = bytes.readUInt16LE(entry + 28);
    const name = bytes.toString('utf8', entry + 46, entry + 46 + nameSize);
    const local = bytes.readUInt32LE(entry + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const content = bytes.subarray(start, start + bytes.readUInt32LE(entry + 20));
    parts.set(name, (bytes.readUInt16LE(entry + 10) === 0 ? content : inflateRawSync(content)).toString());
    entry += 46 + nameSize + bytes.readUInt16LE(entry + 30) + bytes.readUInt16LE(entry + 32);
  }
  return new Map([...parts.get('xl/workbook.xml').matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)]
    .map(([, title, number]) => {
      const sheet = parts.get(`xl/worksheets/sheet${number}.xml`);
      assert.doesNotMatch(sheet, /<f\b/);
      const rows = Array.from(sheet.matchAll(/<row\b[^>]*>(.*?)<\/row>/gs), ([, cells]) =>
        Array.from(cells.matchAll(/<c\b[^>]*>(.*?)<\/c>/gs), ([, content]) => {
          const text = /<t\b[^>]*>(.*?)<\/t>/s.exec(content);
          return text ? readText(text[1]) : Number(/<v>(.*?)<\/v>/s.exec(content)[1]);
        }));
      return [readText(title), rows];
    }));
}

async function tempFiles() {
  try {
    const entries = await readdir(join(tmpdir(), exportRootName));
    return entries.filter((name) => name.startsWith(`campus-class-export-${process.pid}-`));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

async function openApi(t, store) {
  let beforeWrite;
  let onClose;
  const studentKey = randomBytes(32);
  const handlerStore = {
    ...store,
    async transaction(work) {
      const intercept = beforeWrite;
      beforeWrite = null;
      if (intercept) await intercept(await tempFiles());
      return store.transaction(work);
    },
  };
  const { game, positions } = createPreviewServices(handlerStore, clock);
  const api = createPreviewApi({
    CAMPUS_AUTH_MODE: 'mock', NODE_ENV: 'test', CAMPUS_ROSTER_CSV: '',
    CAMPUS_JWT_SECRET: studentKey.toString('base64url'), CAMPUS_TEACHER_ALLOWLIST: teachers,
    CAMPUS_TEACHER_PASSWORD_HASHES: JSON.stringify({ [teachers]: passwordHash }),
    CAMPUS_TEACHER_JWT_SECRET: randomBytes(32).toString('base64url'),
  }, game, positions);
  const server = createServer((req, res) => {
    if (onClose) {
      res.once('close', onClose);
      onClose = null;
    }
    return api(req, res);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie, requestOrigin = origin, signal) => fetch(origin + path, {
    method: 'POST', signal, headers: {
      'Content-Type': 'application/json', ...(requestOrigin && { Origin: requestOrigin }), ...(cookie && { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });
  const response = await post('/api/teacher/login', { account: teachers, password });
  assert.equal(response.status, 200);
  const teacherCookie = response.headers.get('set-cookie').split(';')[0];
  let studentCookie;
  await createSessions(studentKey, 'urn:campus:mock', false, clock).write({
    appendHeader: (_header, value) => { studentCookie = value.split(';')[0]; },
  }, 'player', '00001');
  return {
    teacherCookie, studentCookie,
    download: (body, cookie = teacherCookie, requestOrigin, signal) => post('/api/admin/export', body, cookie, requestOrigin, signal),
    beforeNextWrite: (callback) => { beforeWrite = callback; },
    observeClose: () => new Promise((resolve) => { onClose = resolve; }),
  };
}

async function auditsOf(store, action, count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await store.read((tx) => tx.all(`SELECT actor_id, event_date, details
      FROM admin_audit WHERE action = ?`, action));
    if (rows.length >= count) return rows.map((row) => ({
      ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
    }));
    await delay(20);
  }
  assert.fail(`未收到 ${count} 条 ${action} 审计记录`);
}

for (const mysql of [false, true]) {
  test(`P0-6 ${mysql ? 'MySQL' : 'SQLite'}`, { skip: mysql && !process.env.MYSQL_TEST_URL }, async (t) => {
    const store = await openStore(t, mysql);
    await seedReport(store);
    const api = await openApi(t, store);

    await t.test('导出实名班级，保留文本、排名及异常标记', async () => {
      const response = await api.download({ eventDate: day });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-disposition'), /attachment;.*\.xlsx/);
      const sheets = readWorkbook(Buffer.from(await response.arrayBuffer()));
      assert.equal(sheets.size, 4);
      const [header, ...rows] = sheets.get('总榜');
      assert.deepEqual(header, ['排名', '姓名', '学号', '年级', '学院', '班级', '电话', '邮箱', '有效里程（米）', '积分', '抓捕数', '参与场次', '异常标记']);
      assert.deepEqual(rows, [
        [1, "'=1+1", '00002', "'-2026", '商学院', '计科[1]班', "'+0012", "'@sample.invalid", 700, 20, 2, 1, 'data_gap、未结算'],
        [2, '示例甲', '00001', '2026', '信息学院', '计科[1]班', '00123456789', '0001@example.invalid', 2150.5, 11, 1, 2, 'data_gap、成绩作废'],
        [3, '示例乙', '00003', '2026', '信息学院', longClassName, '00123456789', '0001@example.invalid', 2000, 0, 0, 1, ''],
        [0, '示例&丙', '00004', '2026', '信息学院', '计科[1]班', '00123456789', '0001@example.invalid', 0, 0, 0, 0, ''],
      ]);
      assert.deepEqual(sheets.get('信息学院-2026-计科1班').slice(1), [rows[1], rows[3]]);
      assert.deepEqual(sheets.get('商学院--2026-计科1班').slice(1), [rows[0]]);
      assert.deepEqual(sheets.get('甲'.repeat(29) + '🐈').slice(1), [rows[2]]);
      const [audit] = await auditsOf(store, 'export.succeeded', 1);
      assert.equal(audit.actor_id, teachers);
      assert.equal(audit.event_date, day);
      assert.equal(audit.details.rows, 4);
      assert.equal(audit.details.classes, 3);
      assert.doesNotMatch(JSON.stringify(audit.details), /00123456789|example\.invalid|示例/);
      assert.deepEqual(await tempFiles(), []);
    });

    await t.test('空名单保留总榜表头，有报名而无参与则填零', async () => {
      const empty = readWorkbook(Buffer.from(await (await api.download({ eventDate: firstEventDate })).arrayBuffer()));
      assert.deepEqual([...empty.keys()], ['总榜']);
      assert.equal(empty.get('总榜').length, 1);
      const idle = readWorkbook(Buffer.from(await (await api.download({ eventDate: tomorrow })).arrayBuffer()));
      assert.equal(idle.get('总榜').length, 6);
      for (const row of idle.get('总榜').slice(1)) {
        assert.equal(row[0], 0);
        assert.deepEqual(row.slice(8), [0, 0, 0, 0, '']);
      }
      await auditsOf(store, 'export.succeeded', 3);
    });

    await t.test('拒绝越权和空日期，审计失败并清理已生成的临时文件', async () => {
      for (const [response, status] of [
        [await api.download({ eventDate: day }, null), 401],
        [await api.download({ eventDate: day }, api.studentCookie), 401],
        [await api.download({ eventDate: day }, api.teacherCookie, 'https://other.invalid'), 403],
        [await api.download({ eventDate: '' }), 400],
      ]) {
        assert.equal(response.status, status);
        assert.match(response.headers.get('content-type'), /^application\/json/);
        await response.json();
      }
      let filesBeforeFailure;
      api.beforeNextWrite((files) => {
        filesBeforeFailure = files;
        throw new Error('test audit unavailable');
      });
      const failed = await api.download({ eventDate: day });
      assert.equal(failed.status, 500);
      await failed.json();
      assert.equal(filesBeforeFailure.length, 1);
      const audits = await auditsOf(store, 'export.failed', 5);
      assert.equal(audits.filter(({ actor_id }) => actor_id === teachers).length, 2);
      assert.ok(audits.some((audit) => audit.actor_id === teachers && audit.event_date === day));
      assert.deepEqual(await tempFiles(), []);
    });

    await t.test('客户端断开后清理临时文件并记录失败', async () => {
      const controller = new AbortController();
      const closed = api.observeClose();
      api.beforeNextWrite(async () => {
        controller.abort();
        await closed;
      });
      await assert.rejects(api.download({ eventDate: day }, undefined, undefined, controller.signal), { name: 'AbortError' });
      const audits = await auditsOf(store, 'export.failed', 6);
      assert.ok(audits.some(({ details }) => details.phase === 'download'));
      assert.deepEqual(await tempFiles(), []);
    });

    await t.test('2000 行和各班工作表在 10 秒内下载完成', async (subtest) => {
      await insertStudents(store, Array.from({ length: 1996 }, (_, i) => ({
        id: `perf-${String(i).padStart(4, '0')}`, name: '性能样本', className: `班级-${i % 40}`,
      })));
      await store.transaction((tx) => tx.run(`INSERT INTO participation_sessions
        (event_id, session_id, player_id, role, gender, started_at, status, status_at, valid_meters)
        SELECT ?, ?, id, 'mouse', 'female', ?, 'settled', ?, 3000 FROM ${store.tables.users} WHERE id LIKE 'perf-%'`,
      eventId, morning.id, morning.startsAt, morning.endsAt));
      const started = performance.now();
      const response = await api.download({ eventDate: day });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 10_000, `下载耗时 ${elapsed.toFixed(0)} ms`);
      subtest.diagnostic(`2000 行下载 ${elapsed.toFixed(0)} ms`);
      const sheets = readWorkbook(bytes);
      assert.equal(sheets.get('总榜').length, 2001);
      assert.equal(sheets.size, 44);
      const allIds = [...sheets.values()].slice(1).flatMap((rows) => rows.slice(1).map((row) => row[2]));
      assert.deepEqual(allIds.sort(), sheets.get('总榜').slice(1).map((row) => row[2]).sort());
      await auditsOf(store, 'export.succeeded', 4);
      assert.deepEqual(await tempFiles(), []);
    });
  });
}
