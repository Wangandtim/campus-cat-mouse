import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createBrotliCompress, createGzip } from 'node:zlib';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewApi, createPreviewServices, openPreview } from './api.mjs';
import { readEventSettings } from './admin/event-settings.mjs';
import { openMysqlStore } from './db/mysql.mjs';
import { connectRedis } from './live/redis.mjs';
import { attachLivePositions } from './live/positions.mjs';
import { scheduleSettlements } from './settlements.mjs';
import { scheduleAdminJobs } from './admin/jobs.mjs';
import { purgeExpiredExports } from './security/export-cleanup.mjs';
import { createRateLimiter, limitLiveReports } from './security/rate-limit.mjs';
import { retentionSettings } from './security/retention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
if (!existsSync(resolve(root, 'index.html'))) {
  console.error('请先运行 npm run build。');
  process.exit(1);
}

const retention = retentionSettings(process.env);
const redis = await connectRedis(process.env.REDIS_URL).catch(() => {
  console.error('Redis 启动检查失败，请检查 REDIS_URL 和 Redis 服务。');
  process.exit(1);
});
if (redis) console.log('Redis PING 返回 PONG。');
const checkLimit = createRateLimiter({ env: process.env, redis });

const mysqlUrl = process.env.MYSQL_URL?.trim();
const poolSize = Number(process.env.CAMPUS_MYSQL_POOL_SIZE?.trim() || 60);
const testNow = process.env.CAMPUS_TEST_NOW?.trim();
const testBase = testNow ? Date.parse(testNow) : NaN;
if (testNow && process.env.NODE_ENV === 'production') {
  console.error('production 禁止设置 CAMPUS_TEST_NOW。');
  process.exit(1);
}
if (testNow && !Number.isFinite(testBase)) {
  console.error('CAMPUS_TEST_NOW 不是有效时间。');
  process.exit(1);
}
const startedAt = Date.now();
const clock = testNow ? () => testBase + (Date.now() - startedAt) : Date.now;
let services;
if (mysqlUrl) {
  try {
    const store = await openMysqlStore(mysqlUrl, { poolSize });
    console.log('MySQL 连接检查和迁移已通过。');
    await readEventSettings(store, true);
    services = createPreviewServices(store, clock);
  } catch {
    console.error('MySQL 启动检查或迁移失败。');
    process.exit(1);
  }
} else {
  services = openPreview(undefined, undefined, clock);
  await readEventSettings(services.store, true);
}
const { game, liveGame, positions, purgeLocations, close } = services;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true, service: 'campus-cat-mouse', time: clock(),
      positionQueue: positionQueueStats?.(),
    }));
    return;
  }
  if (/^\/(api|_AMapService)(?:\/|$)/.test(url.pathname)) return void api(req, res);
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405).end();
    return;
  }
  const candidate = resolve(root, '.' + url.pathname);
  const withinDist = candidate.startsWith(root + sep);
  const adminPage = url.pathname === '/admin' || url.pathname === '/admin/';
  if (adminPage) {
    try {
      await checkLimit.requireRedis();
    } catch (error) {
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : error.message);
      return;
    }
  }
  const appEntry = url.pathname === '/' || adminPage;
  const file = appEntry ? resolve(root, 'index.html') : candidate;
  if ((!appEntry && !withinDist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  const metadata = statSync(file);
  const type = mime[extname(file)] ?? 'application/octet-stream';
  const accepts = String(req.headers['accept-encoding'] ?? '');
  const encoding = accepts.includes('br') ? 'br' : accepts.includes('gzip') ? 'gzip' : '';
  const compressible = /^(text\/|application\/(javascript|json|xml|manifest)|image\/svg)/.test(type) && metadata.size >= 1024;
  const headers = {
    'Content-Type': type,
    'Cache-Control': adminPage ? 'no-store' : url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(adminPage ? { 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } : {}),
  };
  if (compressible) headers.Vary = 'Accept-Encoding';
  if (encoding && compressible) {
    headers['Content-Encoding'] = encoding;
  } else {
    headers['Content-Length'] = metadata.size;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const source = createReadStream(file);
  if (encoding && compressible) {
    const encoder = encoding === 'br' ? createBrotliCompress() : createGzip();
    source.on('error', () => res.destroy());
    source.pipe(encoder).on('error', () => res.destroy()).pipe(res);
  } else {
    source.pipe(res);
  }
});

const { io, profileChanged, positionQueueStats } = attachLivePositions(server, { game: liveGame, positions, redis, clock });
limitLiveReports(io, checkLimit);
const api = createPreviewApi(process.env, game, positions, profileChanged, checkLimit);
await purgeExpiredExports(clock(), retention.exportRetentionMs)
  .catch(() => console.warn('导出临时文件启动清理失败。'));
const settlements = scheduleSettlements(async (now) => {
  try {
    await api.admin?.prepareSettlementDays(now);
  } finally {
    await game.settleDue(now);
  }
}, { clock, onError: () => console.error('场次结算失败，稍后补算。') });
await settlements.ready;
let locationCleanup;
function purgeLocationsWhenIdle() {
  locationCleanup ??= purgeLocations(clock(), retention.positionRetentionMs)
    .catch(() => console.warn('过期位置清理失败，稍后重试。'))
    .finally(() => { locationCleanup = undefined; });
  return locationCleanup;
}
await purgeLocationsWhenIdle();
const locationTimer = setInterval(purgeLocationsWhenIdle, retention.positionSweepMs);
locationTimer.unref();
const stopAdmin = api.admin && scheduleAdminJobs(api.admin, clock);
server.once('close', () => {
  clearInterval(locationTimer);
  void Promise.all([settlements.stop(), stopAdmin?.(), locationCleanup]).then(close)
    .catch(() => console.error('数据库关闭失败。'));
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`校园追光预览 http://127.0.0.1:${port}`));
