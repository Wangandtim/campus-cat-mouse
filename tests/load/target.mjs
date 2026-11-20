import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createPreviewApi, createPreviewServices } from '../../server/api.mjs';
import { createSessions } from '../../server/auth/session.mjs';
import { openSqliteStore } from '../../server/database.mjs';
import { DatabaseBusyError } from '../../server/db/capacity.mjs';
import { eventId } from '../../server/db/migrations.mjs';
import { attachLivePositions } from '../../server/live/positions.mjs';
import { connectRedis } from '../../server/live/redis.mjs';
import { sessionWindow } from '../../server/rules.mjs';
import { createRateLimiter, limitLiveReports } from '../../server/security/rate-limit.mjs';
import { retentionSettings } from '../../server/security/retention.mjs';
import { scheduleSettlements } from '../../server/settlements.mjs';
import campus from '../../src/data/campus.json' with { type: 'json' };
import { inWindow, listenForCommands, observe, playerId, positionSampleKey, processSampler, roleOf, sampleTime } from './metrics.mjs';

assert.ok(process.send, 'Run through tests/load/run.mjs');
const mysql = createRequire(import.meta.url)('mysql2/promise');
const createPool = mysql.createPool;
let pool;
let poolLimit;
let phase;
let redis;
let sqlLock;
function poolLevels() {
  const { _allConnections, _freeConnections, _connectionQueue } = pool.pool;
  return {
    limit: poolLimit,
    open: _allConnections.length,
    busy: _allConnections.length - _freeConnections.length,
    queued: _connectionQueue.length,
  };
}
function observePool() {
  if (!inWindow(phase, Date.now())) return;
  for (const [key, count] of Object.entries(poolLevels())) {
    phase.poolPeak[key] = Math.max(phase.poolPeak[key] ?? 0, count);
  }
}
// Read pool counters on the real mysql2 pool, including short bursts between 1s samples.
mysql.createPool = function instrumentPool(options) {
  poolLimit = options.connectionLimit;
  pool = createPool(options);
  const acquire = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const started = performance.now();
    const measured = inWindow(phase, Date.now()) ? phase : undefined;
    observePool();
    const pending = acquire();
    observePool();
    try {
      const connection = await pending;
      if (measured) observe(measured.poolWait, performance.now() - started);
      return connection;
    } catch (error) {
      if (measured) {
        if (error.message === 'Queue limit reached.' || error.message === 'No connections available.') measured.poolRejected++;
        else measured.poolOtherErrors++;
      }
      throw error;
    }
  };
  return pool;
};

let server, io, store, timer, sweeper, settlements, attached;
const selectProcess = processSampler();
let sampling = false;
async function sample() {
  const measured = phase;
  if (sampling || !inWindow(measured, Date.now())) return;
  sampling = true;
  const status = {
    ...selectProcess(), sockets: io.of('/').sockets.size, engineSockets: io.engine.clientsCount,
    redisReady: redis.isReady, ...(pool && { pool: poolLevels() }),
    ...(store.capacityStats && { dbCapacity: store.capacityStats() }),
    ...(attached && { admission: attached.admissionStats() }),
  };
  if (redis.isReady) {
    const probe = redis.withCommandOptions({ timeout: 700 });
    const started = performance.now();
    try {
      const [pingMs, info] = await Promise.all([
        probe.ping().then(() => performance.now() - started),
        probe.info('memory'),
      ]);
      status.redisRttMs = Math.round(pingMs * 1000) / 1000;
      status.redisBytes = Number(/^used_memory:(\d+)/m.exec(info)?.[1]);
    } catch {
      status.redisProbeFailed = true;
    }
  }
  if (sqlLock) {
    try {
      const [[row]] = await sqlLock.query('SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits');
      status.mysqlLockWaiters = row.waiting;
    } catch {
      status.mysqlLockProbeFailed = true;
    }
  }
  measured.samples.push(status);
  sampling = false;
}

const warn = console.warn;
console.warn = (message, ...args) => {
  if (message === '实时位置推送暂时不可用。' && inWindow(phase, Date.now())) phase.snapshotErrors++;
  warn(message, ...args);
};

listenForCommands({
  async boot({ sqlite, mysqlUrl, redisUrl, roster, key, count, seed, epoch }) {
    const session = sessionWindow(campus.startDate, 'morning');
    // Keep the event clock continuous when a new target uses the same temporary MySQL data.
    const clock = () => session.startsAt + 900_000 + Date.now() - epoch;
    assert.equal(new URL(redisUrl).hostname, '127.0.0.1');
    if (mysqlUrl) {
      const url = new URL(mysqlUrl);
      assert.equal(url.hostname, '127.0.0.1');
      assert.match(url.pathname, /^\/campus_load_[a-f0-9]{16}$/);
      const { openMysqlStore } = await import('../../server/db/mysql.mjs');
      store = await openMysqlStore(mysqlUrl);
      assert.ok(pool, 'Missing MySQL pool telemetry');
    } else {
      assert.equal(sqlite, 'load.sqlite3');
      store = openSqliteStore(sqlite);
    }
    if (seed) {
      const now = clock();
      await store.transaction(async (tx) => {
        await tx.ensureSession(session.id);
        for (let index = 0; index < count; index++) {
          const id = playerId(index);
          const role = roleOf(index);
          await tx.run(`INSERT INTO ${store.tables.users}
            (id, openid, nickname, name, student_id, gender, created_at, role, stage, sharing)
            VALUES (?, ?, ?, ?, ?, 'male', ?, ?, 'morning', 1)`, id, id, id, id, id, now, role);
          await tx.run('INSERT INTO event_registrations (event_id, user_id, created_at) VALUES (?, ?, ?)', eventId, id, now);
          await tx.run(`INSERT INTO participation_sessions
            (event_id, session_id, player_id, role, gender, started_at, status, status_at)
            VALUES (?, ?, ?, ?, 'male', ?, 'active', ?)`, eventId, session.id, id, role, now, now);
        }
      });
    }
    redis = await connectRedis(redisUrl);
    const { game, liveGame, positions, purgeLocations } = createPreviewServices(store, clock);
    const pendingReports = new Map();
    const trackedPositions = {
      ...positions,
      async save(id, point, ...args) {
        const at = sampleTime(point.lat, epoch);
        const measured = inWindow(phase, at) ? phase : undefined;
        const ingress = pendingReports.get(id);
        const started = performance.now();
        const outcomes = measured?.positionOutcomes;
        const key = outcomes && positionSampleKey(id, at);
        try {
          if (outcomes && outcomes[key] !== 'persisted') outcomes[key] = 'attempted';
          if (measured?.injectedFailures) {
            const seat = Number(id.slice('load-'.length)) % 10;
            const remaining = (seat === 0 ? 1 : seat === 1 ? 2 : 0) - (measured.injectedFailures[key] ?? 0);
            if (remaining > 0) {
              measured.injectedFailures[key] = (measured.injectedFailures[key] ?? 0) + 1;
              throw new DatabaseBusyError(seat === 0 ? 'Database queue is full.' : 'Database queue timed out.');
            }
          }
          const saved = await positions.save(id, point, ...args);
          if (measured && saved?.session_id === session.id) {
            if (outcomes?.[key] === 'persisted') {
              measured.duplicateCommits++;
              return saved;
            }
            if (outcomes) outcomes[key] = 'persisted';
            measured.persisted++;
            observe(measured.persistLatency, Date.now() - at);
            if (ingress?.at === at) observe(measured.ingressLatency, performance.now() - ingress.started);
            observe(measured.saveLatency, performance.now() - started);
            measured.lastPersistAt = Date.now();
            measured.firstPersistAt ??= measured.lastPersistAt;
            bumpTime(measured.persistBySecond, measured, measured.lastPersistAt);
          }
          return saved;
        } catch (error) {
          if (outcomes && error?.code === 'DB_BUSY') measured.dbBusyAttempts++;
          throw error;
        } finally {
          if (pendingReports.get(id)?.at === at) pendingReports.delete(id);
        }
      },
    };
    let api;
    server = createServer((req, res) => {
      if (api && req.url.startsWith('/api/preview/')) void api(req, res);
      else res.writeHead(404).end();
    });
    attached = attachLivePositions(server, { game: liveGame, positions: trackedPositions, redis, clock });
    io = attached.io;
    io.use((socket, accept) => {
      socket.use(([event, point], next) => {
        if (event === 'live:position') {
          const at = sampleTime(point?.lat, epoch);
          if (inWindow(phase, at)) {
            phase.ingress++;
            const id = socket.data.player.id;
            if (phase.positionOutcomes) phase.positionOutcomes[positionSampleKey(id, at)] ??= 'received';
            pendingReports.set(id, { at, started: performance.now() });
          }
        }
        next();
      });
      accept();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const publicOrigin = `https://127.0.0.1:${port}`;
    const env = {
      NODE_ENV: 'production', CAMPUS_AUTH_MODE: 'wechat', CAMPUS_JWT_SECRET: key, CAMPUS_ROSTER_CSV: roster,
      CAMPUS_PUBLIC_ORIGIN: publicOrigin, WECHAT_APP_ID: 'load-fixture', WECHAT_APP_SECRET: 'load-fixture',
      WECHAT_REDIRECT_ALLOWLIST: publicOrigin + '/api/auth/callback',
    };
    const checkLimit = createRateLimiter({ env, redis });
    limitLiveReports(io, checkLimit);
    api = createPreviewApi(env, game, positions, attached.profileChanged, checkLimit);
    settlements = scheduleSettlements(game.settleDue, { clock });
    await settlements.ready;
    const retention = retentionSettings({});
    await purgeLocations(clock(), retention.positionRetentionMs);
    sweeper = setInterval(() => void purgeLocations(clock(), retention.positionRetentionMs)
      .catch(() => console.warn('清理临时压测库位置失败。')), retention.positionSweepMs);
    timer = setInterval(() => void sample(), 1000);

    const sessions = createSessions(Buffer.from(key, 'base64url'), publicOrigin, true, clock);
    const cookies = await Promise.all(Array.from({ length: count }, async (_, index) => {
      let cookie;
      await sessions.write({ appendHeader: (_header, value) => { [cookie] = value.split(';'); } }, 'player', playerId(index));
      return cookie;
    }));
    return { port, sessionId: session.id, cookies };
  },
  begin({ start, end, trackPositionSamples, injectPositionBusy }) {
    phase = {
      start, end, ingress: 0, persisted: 0, snapshotErrors: 0, persistLatency: {}, ingressLatency: {},
      saveLatency: {}, persistBySecond: {}, poolPeak: {}, poolWait: {}, poolRejected: 0, poolOtherErrors: 0, samples: [],
      capacityStart: store.capacityStats?.() ?? {}, admissionStart: attached?.admissionStats() ?? {},
      ...(trackPositionSamples && { positionOutcomes: {}, dbBusyAttempts: 0, duplicateCommits: 0 }),
      ...(injectPositionBusy && { injectedFailures: {} }),
    };
    selectProcess();
  },
  stats() {
    const capacity = store.capacityStats?.() ?? {};
    const before = phase.capacityStart ?? {};
    const delta = (key) => Object.values(capacity).reduce((sum, lane) => sum + lane[key], 0) -
      Object.values(before).reduce((sum, lane) => sum + lane[key], 0);
    const admission = attached?.admissionStats() ?? {};
    const admissionBefore = phase.admissionStart ?? {};
    return {
      ...phase,
      poolRejected: phase.poolRejected + Math.max(0, delta('rejected')),
      poolQueueTimeouts: Math.max(0, delta('timedOut')),
      dbCapacity: capacity,
      poolConfig: pool && {
        configuredLimit: poolLimit,
        actualLimit: pool.pool.config.connectionLimit,
      },
      admission: {
        ...admission,
        busy: admission.busy - admissionBefore.busy,
        accepted: admission.accepted - admissionBefore.accepted,
      },
    };
  },
  async lock({ url, rows = [], all = false }) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.match(parsed.pathname, /^\/campus_load_[a-f0-9]{16}$/);
    sqlLock = await mysql.createConnection(url);
    await sqlLock.beginTransaction();
    const query = all ? 'SELECT id FROM users ORDER BY id FOR UPDATE' :
      `SELECT id FROM users WHERE id IN (${rows.map(() => '?').join(',')}) FOR UPDATE`;
    const [locked] = await sqlLock.execute(query, all ? [] : rows.map(playerId));
    return { at: Date.now(), rows: locked.length };
  },
  async slowReads({ seconds = 14 }) {
    const lanes = { handshake: 8, broadcast: 4, recovery: 2, general: 6 };
    const startedAt = Date.now();
    const results = await Promise.allSettled(Object.entries(lanes).flatMap(([lane, count]) =>
      Array.from({ length: count }, () => store.read(
        (tx) => tx.get('SELECT SLEEP(?) AS sleep_result', seconds), { lane, timeoutMs: (seconds + 5) * 1000 },
      ))));
    return {
      startedAt, endedAt: Date.now(), submitted: results.length,
      completed: results.filter(({ status }) => status === 'fulfilled').length,
      rejected: results.filter(({ status }) => status === 'rejected').length,
      rejectionReasons: results.filter(({ status }) => status === 'rejected')
        .map(({ reason }) => ({ name: reason.name, code: reason.code, message: reason.message })),
      pool: poolLevels(), capacity: store.capacityStats?.(),
      lanes,
    };
  },
  async unlock() {
    await sqlLock.rollback();
    await sqlLock.end();
    sqlLock = undefined;
    return Date.now();
  },
  breakTransport() {
    const sockets = [...io.of('/').sockets.values()];
    for (const socket of sockets) socket.conn.close(true);
    return { count: sockets.length, at: Date.now() };
  },
  async stop() {
    clearInterval(sweeper);
    clearInterval(timer);
    if (sqlLock) sqlLock.destroy();
    await io.close();
    await settlements.stop();
    redis.destroy();
    await store.close();
  },
});

function bumpTime(counts, measured, at) {
  const second = Math.floor((at - measured.start) / 1000);
  counts[second] = (counts[second] ?? 0) + 1;
}
