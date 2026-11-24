import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createConnection } from 'mysql2/promise';
import { createClient } from 'redis';
import { distribution, mergeCounts } from './metrics.mjs';

const { values: args } = parseArgs({ options: {
  mysql: { type: 'string' }, redis: { type: 'string' }, k6: { type: 'string' }, out: { type: 'string' },
  shards: { type: 'string' },
  quick: { type: 'boolean' }, verify: { type: 'boolean' }, 'k6-only': { type: 'boolean' },
  'mysql-fault-only': { type: 'boolean' }, 'resilience-only': { type: 'boolean' },
  'position-retry-only': { type: 'boolean' },
} });
assert.ok(args.mysql && args.redis && args.out, 'Provide --mysql <mysqld> --redis <redis-server> --out <new JSON path>');
assert.ok(!args['k6-only'] || args.k6, 'Provide --k6 with --k6-only');
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const tmp = await realpath(tmpdir());
const directory = await mkdtemp(join(tmp, 'campus-p07c-run-'));
const output = resolve(args.out);
const shards = Number(args.shards ?? 4);
assert.ok(Number.isInteger(shards) && shards > 0 && shards <= 2010, '--shards must be between 1 and 2010');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|systemdrive|windir|temp|tmp|comspec|pathext|userprofile|localhost|appdata|localappdata|home|programfiles|campus_position_write_behind)$/i.test(key)));
const jobs = new Set();
const epoch = Date.now();
const total = 2010;
const positionRetry = args['position-retry-only'];
const breakAfterMs = 7500;
const report = {
  startedAt: new Date(epoch).toISOString(), epoch, node: process.version, os: `${process.platform} ${release()}`,
  task: positionRetry ? 'P0-7d2' : args['resilience-only'] ? 'P0-7d1' : 'P0-7c',
  cpu: cpus()[0].model, logicalCpus: cpus().length,
  memMiB: Math.round(totalmem() / 2 ** 20), shards, stages: [], gates: [],
};
let sequence = 0;
let shutdownMysql;

function track(child, label) {
  jobs.add(child);
  child.lines = [];
  child.on('error', (error) => { child.startError = error; });
  child.once('exit', () => jobs.delete(child));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => {
      child.lines = child.lines.concat(chunk.trimEnd().split(/\r?\n/)).slice(-30);
    });
  }
  child.label = label;
  return child;
}

function executable(path, argv, { cwd = directory, extraEnv = {} } = {}) {
  return track(spawn(path, argv, { cwd, env: { ...env, ...extraEnv }, windowsHide: true }), basename(path));
}

function forkFixture(file) {
  return track(fork(fileURLToPath(new URL(file, import.meta.url)), [], {
    cwd: directory, env, execArgv: [], silent: true, windowsHide: true,
  }), file);
}

function request(child, command, data = {}) {
  assert.ok(child.connected, `${child.label} disconnected`);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    function finish(error, answer) {
      clearTimeout(timer);
      child.off('exit', exited);
      child.off('message', message);
      if (error) reject(error);
      else resolve(answer);
    }
    const exited = () => finish(new Error(`${child.label}: ${child.lines.at(-1) ?? 'process exited'}`));
    const message = (answer) => {
      if (answer.id === id) finish(answer.error && new Error(`${child.label} ${command}: ${answer.error}`), answer.result);
    };
    const timer = setTimeout(() => finish(new Error(`${child.label} ${command}: timeout`)), 90_000);
    child.on('message', message);
    child.once('exit', exited);
    child.send({ id, command, ...data }, (error) => { if (error) finish(error); });
  });
}

async function stop(child) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
}

async function resultOf(child) {
  if (child.startError) throw child.startError;
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return 1;
  const [code] = await once(child, 'close');
  return code ?? 1;
}

async function localPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(child, check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.startError) throw child.startError;
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { return await check(); } catch { await delay(250); }
  }
  throw new Error(`${child.label} startup: ${child.lines.join('\n')}`);
}

async function startDatabases() {
  const datadir = join(directory, 'mysql');
  const redisDir = join(directory, 'redis');
  await mkdir(redisDir);
  const mysqlExe = resolve(args.mysql);
  const redisExe = resolve(args.redis);
  const mysqlPort = await localPort();
  const redisPort = await localPort();
  const mysqlFlags = ['--no-defaults', `--basedir=${dirname(dirname(mysqlExe))}`, `--datadir=${datadir}`,
    `--tmpdir=${directory}`, '--console'];
  const init = executable(mysqlExe, [...mysqlFlags, '--initialize-insecure']);
  assert.equal(await resultOf(init), 0, init.lines.join('\n'));
  const mysql = executable(mysqlExe, [...mysqlFlags, `--port=${mysqlPort}`, '--bind-address=127.0.0.1', '--mysqlx=OFF']);
  const rootLogin = { host: '127.0.0.1', port: mysqlPort, user: 'root', connectTimeout: 800 };
  const connection = await waitFor(mysql, () => createConnection(rootLogin));
  const checkDataDir = async (client) => {
    const [[info]] = await client.query('SELECT @@datadir AS dir, @@innodb_buffer_pool_size AS buffer, VERSION() AS version');
    assert.equal(await realpath(info.dir), await realpath(datadir));
    return info;
  };
  shutdownMysql = async () => {
    if (mysql.exitCode !== null || mysql.signalCode !== null) return;
    const client = await createConnection(rootLogin);
    try {
      await checkDataDir(client);
      await Promise.all([
        once(mysql, 'exit', { signal: AbortSignal.timeout(15_000) }),
        client.query('SHUTDOWN'),
      ]);
    } finally {
      client.destroy();
    }
  };
  const schema = `campus_load_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  try {
    const info = await checkDataDir(connection);
    await connection.query('ALTER USER \'root\'@\'localhost\' IDENTIFIED BY ?', [password]);
    rootLogin.password = password;
    await connection.query(`CREATE DATABASE \`${schema}\``);
    report.mysql = { version: info.version, bufferMiB: Number(info.buffer) / 2 ** 20 };
  } finally {
    await connection.end();
  }
  const mysqlUrl = `mysql://root:${password}@127.0.0.1:${mysqlPort}/${schema}`;
  const redisPass = randomBytes(24).toString('hex');
  const redisUrl = `redis://:${redisPass}@127.0.0.1:${redisPort}`;
  let redis;
  async function restartRedis() {
    redis = executable(redisExe, ['--bind', '127.0.0.1', '--port', String(redisPort),
      '--dir', '.', '--requirepass', redisPass, '--save', '', '--appendonly', 'no'], { cwd: redisDir });
    await waitFor(redis, async () => {
      const client = createClient({ url: redisUrl, socket: { connectTimeout: 800, reconnectStrategy: false } });
      client.on('error', () => {});
      try {
        await client.connect();
        assert.equal(await client.ping(), 'PONG');
        const version = /^redis_version:([^\r\n]+)/m.exec(await client.info('server'))?.[1];
        assert.ok(Number(version?.split('.')[0]) >= 6, 'Redis with GEOSEARCH is required');
        report.redis = version;
      } finally {
        if (client.isOpen) client.destroy();
      }
    });
    return Date.now();
  }
  await restartRedis();
  return { mysqlUrl, redisUrl, restartRedis, stopRedis: () => stop(redis) };
}

async function createTarget(databases, count, { sqlite, seed = true } = {}) {
  const child = forkFixture('./target.mjs');
  const boot = await request(child, 'boot', {
    sqlite: sqlite ? 'load.sqlite3' : undefined, mysqlUrl: sqlite ? undefined : databases.mysqlUrl,
    redisUrl: databases.redisUrl, roster: join(directory, 'synthetic.csv'),
    key: randomBytes(32).toString('base64url'), count, seed, epoch,
  });
  return { child, ...boot, origin: `http://127.0.0.1:${boot.port}` };
}

const workers = [];
const forWorkers = (command, data) => Promise.all(workers.map((child, index) =>
  request(child, command, typeof data === 'function' ? data(index) : data)));

async function configure(target) {
  await forWorkers('configure', { origin: target.origin, sessionId: target.sessionId, epoch });
}

async function add(target, from, to, rampMs, startsAt = Date.now() + 300) {
  const clients = Array.from({ length: to - from }, (_, offset) => {
    const index = from + offset;
    return { index, cookie: target.cookies[index], at: startsAt + Math.floor(offset * rampMs / (to - from)) };
  });
  await forWorkers('add', (shard) => ({ clients: clients.filter(({ index }) => index % shards === shard) }));
}

async function until(at) {
  await delay(Math.max(0, at - Date.now()));
}

async function stabilize() {
  let setupRetries = 0;
  let missing = (await forWorkers('missing')).flat();
  for (let round = 0; missing.length && round < 2; round++) {
    const start = Date.now() + 500;
    const seats = missing.map((index, offset) => ({ index, at: start + 10 * offset }));
    setupRetries += seats.length;
    await forWorkers('restore', (shard) => ({ seats: seats.filter(({ index }) => index % shards === shard) }));
    await until(seats.at(-1).at + 6500);
    missing = (await forWorkers('missing')).flat();
  }
  return { setupRetries, readyMissingBeforeWindow: missing.length };
}

async function persist() {
  await writeFile(output, JSON.stringify(report));
}

function summarizePositionWindows(clients, server) {
  const windows = {};
  for (const client of clients) {
    for (const [key, window, outcome] of client.positionSamples) {
      const bucket = windows[window] ??= { planned: 0, received: 0, attempted: 0, persisted: 0, clientOutcomes: {} };
      bucket.planned++;
      bucket.clientOutcomes[outcome] = (bucket.clientOutcomes[outcome] ?? 0) + 1;
      const write = server.positionOutcomes[key];
      if (write) bucket.received++;
      if (write === 'attempted' || write === 'persisted') bucket.attempted++;
      if (write === 'persisted') bucket.persisted++;
    }
  }
  for (const bucket of Object.values(windows)) {
    bucket.positionErrorRate = (bucket.planned - bucket.persisted) / bucket.planned;
    bucket.writeErrorRate = bucket.attempted ? (bucket.attempted - bucket.persisted) / bucket.attempted : null;
  }
  return windows;
}

async function measure(target, name, seconds, action, collectWorkers = true) {
  const start = Date.now() + 1200;
  const end = start + seconds * 1000;
  const window = { start, end, trackPositionSamples: positionRetry,
    reconnectAt: positionRetry && name === 'reconnect-storm' ? start + breakAfterMs : undefined,
    injectPositionBusy: positionRetry && name === 'transient-position-writes' };
  await request(target.child, 'begin', window);
  if (collectWorkers) await forWorkers('begin', window);
  console.log(`${name}: ${seconds}s`);
  await until(start);
  const scenario = await action?.(start);
  await until(end + 5500);
  const server = await request(target.child, 'stats');
  const clients = collectWorkers ? await forWorkers('stats') : [];
  const result = { name, seconds, scenario, server, clients };
  const peak = Math.max(0, ...server.samples.map((sample) => sample.sockets));
  if (collectWorkers) {
    const count = (key) => clients.reduce((sum, client) => sum + client[key], 0);
    const disconnects = clients.reduce((sum, client) => sum +
      Object.values(client.disconnects ?? {}).reduce((total, value) => total + value, 0), 0);
    const visible = distribution(mergeCounts(clients.map((client) => client.visible)));
    const sendLag = distribution(mergeCounts(clients.map((client) => client.sendLag)));
    const clientCpuMax = Math.max(0, ...clients.flatMap((client) => client.samples.map((sample) => sample.cpuPctOfCore)));
    const clientLoopP99Max = Math.max(0, ...clients.flatMap((client) => client.samples.map((sample) => sample.loopP99Ms)));
    const planned = count('planned');
    const scheduled = count('scheduled');
    result.summary = {
      plannedConnections: planned,
      handshakenPlayers: count('everHandshaken'),
      acceptedTransportHandshakes: server.admission?.accepted ?? 0,
      everConnected: count('everReady'),
      currentlyReady: count('ready'),
      connectionSuccessRate: planned ? count('everReady') / planned : 0,
      disconnectEvents: disconnects,
      disconnectRatePerConnection: planned ? disconnects / planned : 0,
      reconnectAttempts: count('reconnectAttempts'),
      reconnectSuccesses: count('reconnects'),
      stateRecovered: count('stateRecovered'),
      plannedPositions: scheduled,
      emittedPositions: count('emitted'),
      persistedPositions: server.persisted,
      positionErrorRate: scheduled ? Math.max(0, scheduled - server.persisted) / scheduled : 1,
      snapshots: count('snapshots'),
      fullTenMouseSnapshots: count('catFull'),
      visibleLatencyMs: visible,
      sendSchedulingLagMs: sendLag,
      loadGenerator: {
        cpuPeakPctOfCore: clientCpuMax,
        eventLoopP99PeakMs: clientLoopP99Max,
        saturated: sendLag.p99 > 1000 || clientCpuMax >= 90 || clientLoopP99Max >= 100,
      },
      poolRejected: server.poolRejected,
      poolQueueTimeouts: server.poolQueueTimeouts,
      admissionBusy: server.admission?.busy ?? 0,
    };
    if (positionRetry) {
      assert.deepEqual(server.poolConfig, { configuredLimit: 60, actualLimit: 60 });
      result.summary.positionWindows = summarizePositionWindows(clients, server);
      result.summary.positionRetry = {
        dbBusyAttempts: server.dbBusyAttempts,
        clientResends: count('positionResends'),
        duplicateCommits: server.duplicateCommits,
      };
      if (window.injectPositionBusy) {
        const injected = Object.keys(server.injectedFailures);
        result.summary.positionRetry.injectedSamples = injected.length;
        result.summary.positionRetry.recoveredInjectedSamples = injected.filter((key) =>
          server.positionOutcomes[key] === 'persisted').length;
      }
    }
    console.log(`${name}: peak=${peak} ready=${result.summary.currentlyReady}/${planned} ` +
      `stored=${server.persisted}/${scheduled} errors=${(result.summary.positionErrorRate * 100).toFixed(2)}% ` +
      `snapshots=${result.summary.snapshots} visibleP95/P99=${visible.p95}/${visible.p99} ` +
      `generatorP99=${sendLag.p99}ms saturated=${result.summary.loadGenerator.saturated} ` +
      `poolRejected=${server.poolRejected}`);
  } else {
    const metric = (key) => scenario.metrics?.[key]?.count ?? 0;
    result.summary = {
      plannedConnections: scenario.count,
      connected: metric('load_rooms_ready'),
      dials: metric('load_dials'),
      persistedPositions: server.persisted,
      snapshots: metric('load_snapshots'),
      poolRejected: server.poolRejected,
      poolQueueTimeouts: server.poolQueueTimeouts,
    };
    console.log(`${name}: exit=${scenario.code} peak=${peak} dials=${metric('load_dials')} ` +
      `ready=${metric('load_rooms_ready')} stored=${server.persisted}/${metric('load_positions_sent')} ` +
      `snapshots=${metric('load_snapshots')} poolRejected=${server.poolRejected}`);
  }
  report.stages.push(result);
  await persist();
  return result;
}

async function retire(target) {
  await forWorkers('clear');
  await request(target.child, 'stop');
  await stop(target.child);
}

async function runK6(target, count, seconds) {
  const credentials = join(directory, 'synthetic-sessions.json');
  const summary = join(directory, 'k6-summary.json');
  await writeFile(credentials, JSON.stringify(target.cookies.slice(0, count)));
  const child = executable(resolve(args.k6), ['run', '--quiet', '--summary-export', summary,
    fileURLToPath(new URL('./socketio.k6.js', import.meta.url))], {
    extraEnv: { K6_NO_USAGE_REPORT: 'true', LOAD_PORT: String(target.port), LOAD_SECONDS: String(seconds),
      LOAD_EPOCH: String(epoch), LOAD_SESSION: target.sessionId, LOAD_COOKIES: credentials },
  });
  const code = await resultOf(child);
  let metrics;
  try { ({ metrics } = JSON.parse(await readFile(summary, 'utf8'))); } catch { /* k6 can exit before writing a summary. */ }
  return { code, count, metrics, diagnostics: code === 0 ? undefined : child.lines };
}

try {
  await writeFile(output, '{}', { flag: 'wx' });
  await writeFile(join(directory, 'synthetic.csv'), 'school,student_no,name\n西安欧亚学院,SYNTHETIC_LOAD,合成测试账号\n');
  const databases = await startDatabases();
  console.log(`Temporary MySQL ${report.mysql.version} and Redis ${report.redis} ready`);
  if (positionRetry) {
    for (let shard = 0; shard < shards; shard++) workers.push(forkFixture('./clients.mjs'));
    const target = await createTarget(databases, total);
    await configure(target);
    await measure(target, 'cold-2000', 45, (start) => add(target, 0, 2000, 0, start + 50));
    await add(target, 2000, total, 300);
    await delay(3000);
    const reconnectSetup = await stabilize();
    assert.equal(reconnectSetup.readyMissingBeforeWindow, 0, 'all fixtures must be ready before the reconnect storm');
    await measure(target, 'reconnect-storm', 45, async (start) => {
      await until(start + breakAfterMs);
      return { ...reconnectSetup, ...await request(target.child, 'breakTransport') };
    });
    const faultSetup = await stabilize();
    assert.equal(faultSetup.readyMissingBeforeWindow, 0, 'all fixtures must be ready before write failures are injected');
    await measure(target, 'transient-position-writes', 15, () => faultSetup);
    await retire(target);
  } else if (args['resilience-only']) {
    for (let shard = 0; shard < shards; shard++) workers.push(forkFixture('./clients.mjs'));
    const target = await createTarget(databases, total);
    await configure(target);
    await measure(target, 'cold-2000', 45, (start) => add(target, 0, 2000, 0, start + 50));

    await add(target, 2000, total, 300);
    await delay(3000);
    const faultSetup = await stabilize();
    assert.equal(faultSetup.readyMissingBeforeWindow, 0, 'all fixtures must be ready before faults are injected');
    await databases.stopRedis();
    const stoppedAt = Date.now();
    await measure(target, 'redis-outage', 12, () => ({ ...faultSetup, stoppedAt }));
    await measure(target, 'redis-recovery', 20, async () => ({ restartedAt: await databases.restartRedis() }));

    const reconnectSetup = await stabilize();
    assert.equal(reconnectSetup.readyMissingBeforeWindow, 0, 'all fixtures must be ready before the reconnect storm');
    await measure(target, 'reconnect-storm', 45, async (start) => {
      await until(start + 7500);
      return { ...reconnectSetup, ...await request(target.child, 'breakTransport') };
    });
    await retire(target);
  } else if (args['mysql-fault-only']) {
    for (let shard = 0; shard < shards; shard++) workers.push(forkFixture('./clients.mjs'));
    const target = await createTarget(databases, total);
    await configure(target);
    await add(target, 0, total, 5000);
    await delay(12_000);
    const setup = await stabilize();
    await measure(target, 'mysql-slow-query-pool-full', 45, async (start) => {
      await until(start + 7500);
      const locked = await request(target.child, 'lock', { url: databases.mysqlUrl, all: true });
      const slowQueries = await request(target.child, 'slowReads', { seconds: 14 });
      return { ...setup, ...locked, slowQueries, unlockedAt: await request(target.child, 'unlock') };
    });
    const reconnectSetup = await stabilize();
    await measure(target, 'reconnect-storm', 45, async (start) => {
      await until(start + 7500);
      return { ...reconnectSetup, ...await request(target.child, 'breakTransport') };
    });
    await retire(target);
  } else if (!args['k6-only']) {
    for (let shard = 0; shard < shards; shard++) workers.push(forkFixture('./clients.mjs'));
    const sqlite = await createTarget(databases, 12, { sqlite: true });
    await configure(sqlite);
    await add(sqlite, 0, 12, 500);
    await delay(8000);
    const smoke = await measure(sqlite, 'sqlite-smoke', 10);
    assert.ok(smoke.clients.reduce((sum, client) => sum + client.catFull, 0) > 0 &&
      smoke.server.persisted > 0 && smoke.clients.every((client) => client.planned === client.ready), 'SQLite smoke failed');
    await retire(sqlite);

    if (args.quick) {
      const mysqlSmoke = await createTarget(databases, 30);
      await configure(mysqlSmoke);
      await measure(mysqlSmoke, 'mysql-smoke', 15, (start) => add(mysqlSmoke, 0, 30, 0, start + 50));
      await retire(mysqlSmoke);
    } else {
      const target = await createTarget(databases, total);
      await configure(target);
      let previous = 0;
      let gatePassed = true;
      for (const [size, seconds] of [[200, 25], [500, 30], [1000, 30], [2000, 60], [2010, 60]]) {
        await add(target, previous, size, 5000);
        await delay(12_000);
        const setup = await stabilize();
        const stage = await measure(target, `steady-${size}`, seconds, () => setup);
        previous = size;
        if (size === 200 || size === 500) {
          const gate = {
            size,
            ready: stage.summary.currentlyReady,
            snapshots: stage.summary.snapshots,
            visibleP95Ms: stage.summary.visibleLatencyMs.p95,
            passed: stage.summary.currentlyReady === size && stage.summary.snapshots > 0 &&
              stage.summary.visibleLatencyMs.p95 !== null && stage.summary.visibleLatencyMs.p95 < 2000,
          };
          report.gates.push(gate);
          await persist();
          console.log(`gate-${size}: ${gate.passed ? 'passed' : 'stopped'} ` +
            `ready=${gate.ready}/${size} snapshots=${gate.snapshots} visibleP95=${gate.visibleP95Ms}`);
          if (!gate.passed) {
            gatePassed = false;
            report.stoppedBefore = size < 500 ? 500 : 1000;
            report.stopReason = `P0-7c 200/500 prerequisite failed at ${size}; larger load stages were not run.`;
            break;
          }
        }
      }
      if (gatePassed) {
        await retire(target);
        const cold = await createTarget(databases, total, { seed: false });
        await configure(cold);
        await measure(cold, 'cold-2000', 45, (start) => add(cold, 0, 2000, 0, start + 50));
        await retire(cold);

        const faultTarget = await createTarget(databases, total, { seed: false });
        await configure(faultTarget);
        await add(faultTarget, 0, total, 5000);
        await delay(12_000);
        const faultSetup = await stabilize();
        await measure(faultTarget, 'redis-restart', 45, async (start) => {
          await until(start + 8000);
          await databases.stopRedis();
          const stoppedAt = Date.now();
          await delay(12_000);
          const restartedAt = await databases.restartRedis();
          return { ...faultSetup, stoppedAt, restartedAt };
        });
        const mysqlSetup = await stabilize();
        await measure(faultTarget, 'mysql-slow-query-pool-full', 45, async (start) => {
          await until(start + 7500);
          const locked = await request(faultTarget.child, 'lock', { url: databases.mysqlUrl, all: true });
          const slowQueries = await request(faultTarget.child, 'slowReads', { seconds: 14 });
          return { ...mysqlSetup, ...locked, slowQueries, unlockedAt: await request(faultTarget.child, 'unlock') };
        });
        const reconnectSetup = await stabilize();
        await measure(faultTarget, 'reconnect-storm', 45, async (start) => {
          await until(start + 7500);
          return { ...reconnectSetup, ...await request(faultTarget.child, 'breakTransport') };
        });
        await retire(faultTarget);
      } else await retire(target);
    }
  }
  if (args.k6 && !args.quick && !report.stopReason) {
    const target = await createTarget(databases, total, { seed: Boolean(args['k6-only']) });
    await measure(target, 'k6-cold-2000', 49, () => runK6(target, 2000, 40), false);
    await retire(target);
  }
  if (args.verify) {
    const options = { cwd: workspace, extraEnv: { MYSQL_TEST_URL: databases.mysqlUrl, REDIS_TEST_URL: databases.redisUrl } };
    const test = process.platform === 'win32'
      ? executable('cmd.exe', ['/d', '/c', 'pnpm', 'test'], options)
      : executable('pnpm', ['test'], options);
    report.verification = { exitCode: await resultOf(test), tail: test.lines };
    console.log(report.verification.tail.slice(-10).join('\n'));
  }
  report.completedAt = new Date().toISOString();
  await persist();
  if (report.verification?.exitCode) process.exitCode = 1;
} finally {
  try { await shutdownMysql?.(); } catch (error) {
    console.error('Temporary MySQL shutdown:', error.message);
    process.exitCode = 1;
  }
  await Promise.allSettled([...jobs].map(stop));
  const target = await realpath(directory);
  assert.equal(dirname(target), tmp);
  assert.match(basename(target), /^campus-p07c-run-/);
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
