import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connectRedis } from '../live/redis.mjs';
import { createRateLimiter } from './rate-limit.mjs';

const request = (remoteAddress, forwarded) => ({
  socket: { remoteAddress },
  headers: { 'x-forwarded-for': forwarded },
});

const limitError = (error) => error.status === 429 && error.code === 'RATE_LIMIT' && error.retryAfter > 0;

test('an empty proxy list ignores forwarded addresses and warns once across limiter instances', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {});
  const first = createRateLimiter({ env: { NODE_ENV: 'test' } });
  const second = createRateLimiter({ env: { NODE_ENV: 'test', CAMPUS_TRUSTED_PROXY_IPS: ' ' } });
  await first('capture', request('127.0.0.1'));
  assert.equal(warning.mock.callCount(), 0);
  for (let i = 1; i <= 20; i++) await first('teacherLogin', request('127.0.0.1', `198.51.100.${i}`));
  await assert.rejects(first('teacherLogin', request('127.0.0.1', '192.0.2.2')), limitError);
  await second('export', request('127.0.0.1', '192.0.2.3'));
  assert.deepEqual(warning.mock.calls.map((call) => call.arguments), [['未配置可信代理，限流使用 socket 地址。']]);
});

test('untrusted forwarding headers share the socket IP budget and the budget recovers', async () => {
  let now = 1_000;
  const check = createRateLimiter({ env: { NODE_ENV: 'test', CAMPUS_TRUSTED_PROXY_IPS: '10.0.0.1' }, clock: () => now });
  for (let i = 1; i <= 20; i++) {
    await check('teacherLogin', request('::ffff:127.0.0.1', `198.51.100.${i}`), `account-${i}`);
  }
  await assert.rejects(check('teacherLogin', request('127.0.0.1', '192.0.2.2'), 'extra'), limitError);
  await check('export', request('127.0.0.1'), 'extra');
  now += 60_000;
  await check('teacherLogin', request('127.0.0.1', '192.0.2.2'), 'extra');
});

test('a configured proxy trusts the nearest untrusted hop and shares account limits across IPs', async () => {
  const check = createRateLimiter({
    env: { NODE_ENV: 'test', CAMPUS_TRUSTED_PROXY_IPS: '127.0.0.1,10.0.0.1' },
  });
  for (let i = 1; i <= 20; i++) {
    await check('teacherLogin', request('::ffff:127.0.0.1', `198.51.100.${i}, 192.0.2.1, 10.0.0.1`));
  }
  await assert.rejects(check('teacherLogin', request('127.0.0.1', '198.51.100.99, 192.0.2.1, 10.0.0.1')), limitError);
  await check('teacherLogin', request('127.0.0.1', '192.0.2.2, 10.0.0.1'));
  for (let i = 2; i <= 6; i++) {
    await check('teacherLogin', request('127.0.0.1', `192.0.2.${i}`), 'teacher');
  }
  await assert.rejects(check('teacherLogin', request('127.0.0.1', '192.0.2.7'), 'teacher'), limitError);
  assert.throws(() => createRateLimiter({ env: { CAMPUS_TRUSTED_PROXY_IPS: '127.0.0.1,proxy.invalid' } }),
    /CAMPUS_TRUSTED_PROXY_IPS/);
});

test('a missing Redis connection only falls back for test or local preview', async () => {
  for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'development', CAMPUS_AUTH_MODE: 'wechat' }]) {
    await assert.rejects(createRateLimiter({ env })('export', request('127.0.0.1')),
      { status: 503, code: 'RATE_UNAVAILABLE' });
  }
  const local = createRateLimiter({ env: { NODE_ENV: 'development', CAMPUS_AUTH_MODE: 'demo' } });
  await local('export', request('127.0.0.1'));
});

test('production only degrades authenticated position limits and bounds the TTL buckets', async () => {
  let now = 1_000;
  const redis = { isReady: false };
  const check = createRateLimiter({ env: { NODE_ENV: 'production' }, redis, clock: () => now, maxLocalKeys: 2 });
  const req = request('127.0.0.1');
  for (const route of ['teacherLogin', 'oauthCallback', 'export', 'capture', 'position']) {
    await assert.rejects(check(route, req), { status: 503, code: 'RATE_UNAVAILABLE' });
  }
  await assert.rejects(check.requireRedis(), { status: 503, code: 'RATE_UNAVAILABLE' });

  for (let i = 0; i < 12; i++) await check('position', req, 'existing');
  await assert.rejects(check('position', req, 'existing'), limitError);
  await assert.rejects(check('position', req, 'new'), limitError);
  now += 10_000;
  await check('position', req, 'new');
  await assert.rejects(check('position', req, 'existing'), limitError);

  redis.isReady = true;
  redis.withCommandOptions = () => ({
    async eval() { return 0; },
    async ping() { return 'PONG'; },
  });
  await check.requireRedis();
  await check('position', req, 'existing');
});

test('Redis counts concurrent requests atomically across clients and expires both buckets',
  { skip: !process.env.REDIS_TEST_URL, timeout: 20_000 }, async (t) => {
    const url = new URL(process.env.REDIS_TEST_URL);
    assert.equal(url.hostname, '127.0.0.1');
    url.pathname = '/12';
    const first = await connectRedis(url.href);
    t.after(() => first.destroy());
    const second = await connectRedis(url.href);
    t.after(() => second.destroy());
    const checks = [first, second].map((redis) => createRateLimiter({ env: { NODE_ENV: 'production' }, redis }));
    const account = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
      checks[index % 2]('position', request(`198.51.100.${index + 1}`), account)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 12);
    const denied = results.filter((result) => result.status === 'rejected');
    assert.ok(denied.every(({ reason }) => limitError(reason)));
    await delay(Math.max(...denied.map(({ reason }) => reason.retryAfter)) * 1000 + 30);
    await checks[1]('position', request('198.51.100.1'), account);
  });
