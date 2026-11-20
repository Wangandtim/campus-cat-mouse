import { createHash } from 'node:crypto';
import { isIP, SocketAddress } from 'node:net';
import { AuthError } from '../auth/error.mjs';

const policies = {
  teacherLogin: { windowMs: 60_000, ip: 20, account: 5 },
  oauthCallback: { windowMs: 60_000, ip: 600, account: 12 },
  export: { windowMs: 60_000, ip: 30, account: 10 },
  capture: { windowMs: 60_000, ip: 6_000, account: 30 },
  position: { windowMs: 10_000, ip: 10_000, account: 12 },
};

// Check all buckets and update their counts and expiry in the same Redis operation.
const consume = `
local retry = 0
for i, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count >= tonumber(ARGV[i + 1]) then
    local ttl = redis.call('PTTL', key)
    if ttl < 0 then
      ttl = tonumber(ARGV[1])
      redis.call('PEXPIRE', key, ttl)
    end
    retry = math.max(retry, ttl, 1)
  end
end
if retry > 0 then return math.ceil(retry / 1000) end
for _, key in ipairs(KEYS) do
  redis.call('INCR', key)
  if redis.call('PTTL', key) < 0 then redis.call('PEXPIRE', key, ARGV[1]) end
end
return 0
`;

function normalizedIp(value) {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return;
  const { address } = new SocketAddress({ address: value, family: 'ipv6' });
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function proxyAddresses(setting) {
  if (!setting?.trim()) return new Set();
  const addresses = setting.split(',').map((entry) => normalizedIp(entry.trim()));
  if (addresses.includes(undefined)) throw new Error('CAMPUS_TRUSTED_PROXY_IPS 必须是逗号分隔的 IP 地址。');
  return new Set(addresses);
}

let warnedAboutForwardedFor = false;
const serviceBusy = '服务繁忙，请稍后重试';

function requestIp(req, trustedProxies) {
  const peer = normalizedIp(req.socket.remoteAddress) ?? 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (trustedProxies.size === 0 && forwarded !== undefined && !warnedAboutForwardedFor) {
    warnedAboutForwardedFor = true;
    console.warn('未配置可信代理，限流使用 socket 地址。');
  }
  if (!trustedProxies.has(peer) || typeof forwarded !== 'string') return peer;

  const hops = forwarded.split(',');
  let address = peer;
  for (let index = hops.length - 1; index >= 0 && trustedProxies.has(address); index--) {
    address = normalizedIp(hops[index].trim());
    if (!address) return peer;
  }
  return address;
}

function bucketKey(route, dimension, id) {
  const digest = createHash('sha256').update(id).digest('base64url');
  return `campus-rate:{${route}}:${dimension}:${digest}`;
}

function consumeInMemory(counters, maxKeys, keys, maximums, windowMs, now) {
  let retry = 0;
  let newKeys = 0;
  for (const [index, key] of keys.entries()) {
    const bucket = counters.get(key);
    if (!bucket) newKeys++;
    if (bucket?.expiresAt > now && bucket.count >= maximums[index]) {
      retry = Math.max(retry, bucket.expiresAt - now);
    }
  }
  if (retry > 0) return Math.ceil(retry / 1000);
  if (counters.size + newKeys > maxKeys) return 1;
  for (const key of keys) {
    const bucket = counters.get(key);
    if (bucket?.expiresAt > now) bucket.count++;
    else counters.set(key, { count: 1, expiresAt: now + windowMs });
  }
  return 0;
}

async function runInRedis(redis, command) {
  if (!redis?.isReady) return;
  let timer;
  try {
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, 1000); });
    const client = redis.withCommandOptions({ timeout: 1000 });
    return await Promise.race([command(client), deadline]);
  } catch {
    // Driver errors can contain connection details. Return a fixed error below.
  } finally {
    clearTimeout(timer);
  }
}

export function createRateLimiter({ env, redis, clock = Date.now, maxLocalKeys = 16_384 }) {
  const trustedProxies = proxyAddresses(env.CAMPUS_TRUSTED_PROXY_IPS);
  const local = !redis && (env.NODE_ENV === 'test' || (env.NODE_ENV === 'development' &&
    ['demo', 'mock', 'roster'].includes(env.CAMPUS_AUTH_MODE?.trim())));
  const counters = new Map();
  let pruneAt = 0;

  async function checkLimit(route, req, account) {
    const policy = policies[route];
    const keys = [bucketKey(route, 'ip', requestIp(req, trustedProxies))];
    const maximums = [policy.ip];
    if (account) {
      keys.push(bucketKey(route, 'account', account));
      maximums.push(policy.account);
    }

    let retryAfter = await runInRedis(redis, (client) =>
      client.eval(consume, { keys, arguments: [policy.windowMs, ...maximums].map(String) }));
    if (!Number.isSafeInteger(retryAfter) || retryAfter < 0) {
      if (!local && !(route === 'position' && account)) throw new AuthError('RATE_UNAVAILABLE', serviceBusy, 503);
      const now = clock();
      if (now >= pruneAt) {
        for (const [key, bucket] of counters) {
          if (bucket.expiresAt <= now) counters.delete(key);
        }
        pruneAt = now + 1000;
      }
      retryAfter = consumeInMemory(counters, maxLocalKeys, keys, maximums, policy.windowMs, now);
    }
    if (retryAfter > 0) {
      const error = new AuthError('RATE_LIMIT', '操作过于频繁，请稍后重试。', 429);
      error.retryAfter = retryAfter;
      throw error;
    }
  }
  checkLimit.requireRedis = async function requireRedis() {
    if (!local && await runInRedis(redis, (client) => client.ping()) !== 'PONG') {
      throw new AuthError('RATE_UNAVAILABLE', serviceBusy, 503);
    }
  };
  return checkLimit;
}

export function limitLiveReports(io, checkLimit) {
  io.use((socket, accept) => {
    let generation = 0;
    socket.use(([event], next) => {
      if (event === 'live:clear-position') generation++;
      if (event !== 'live:position') return next();
      const received = generation;
      void checkLimit('position', socket.request, socket.data.player.id).then(() => {
        if (received === generation) next();
      }, (error) => {
        if (error instanceof AuthError && error.code === 'RATE_LIMIT') {
          socket.emit('live:error', error.message, { code: 'RATE_LIMIT', retryAfter: error.retryAfter });
        } else {
          socket.emit('live:error', serviceBusy, { code: 'RATE_UNAVAILABLE' });
        }
      });
    });
    accept();
  });
}
