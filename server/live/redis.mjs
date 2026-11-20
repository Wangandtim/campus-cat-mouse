import { createClient } from 'redis';

const maxReconnectDelayMs = 5000;
const maxReconnectJitterMs = 200;
const invalidationChannel = 'campus-live:profile-changed';

function observeConnection(client, label) {
  let reported = false;
  function reportFailure() {
    if (reported) return;
    reported = true;
    console.warn(`${label} 暂时不可用。`);
  }
  client.on('error', reportFailure);
  client.on('ready', () => {
    if (reported) console.log(`${label} 已恢复。`);
    reported = false;
  });
  return reportFailure;
}

export async function connectRedis(redisUrl) {
  const url = redisUrl?.trim();
  if (!url) return null;

  let startupChecked = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      reconnectStrategy(retries) {
        if (!startupChecked) return false;
        const backoffMs = Math.min(50 * 2 ** retries, maxReconnectDelayMs - maxReconnectJitterMs);
        const jitterMs = Math.floor(Math.random() * (maxReconnectJitterMs + 1));
        return backoffMs + jitterMs;
      },
    },
  });
  observeConnection(client, 'Redis');

  let timer;
  try {
    const pong = await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis PING 超时。')), 5000);
      }),
    ]);
    if (pong !== 'PONG') throw new Error('Redis PING 响应无效。');
    startupChecked = true;
    return client;
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function openLiveInvalidations(redis, instanceId, invalidate, invalidateCache) {
  const subscriber = redis.duplicate();
  const reportFailure = observeConnection(subscriber, '实时状态 Redis 订阅');
  function receive(message) {
    try {
      const change = JSON.parse(message);
      if (change.instanceId !== instanceId && typeof change.id === 'string' && Number.isFinite(change.at)) {
        invalidate(change.id, change.at);
      }
    } catch {
      // A malformed message has no effect on local state.
    }
  }
  function register() {
    void subscriber.subscribe(invalidationChannel, receive)
      .then(() => subscriber.off('ready', register)).catch(reportFailure);
  }
  // node-redis restores existing subscriptions before emitting ready.
  subscriber.on('ready', register);
  subscriber.on('ready', invalidateCache);

  let publishFailed = false;
  void subscriber.connect().catch(reportFailure);
  return {
    async publish(id, at) {
      if (!redis.isReady) return;
      try {
        await redis.withCommandOptions({ timeout: 400 }).publish(invalidationChannel, JSON.stringify({ instanceId, id, at }));
        publishFailed = false;
      } catch {
        if (!publishFailed) console.warn('实时状态 Redis 发布暂时不可用。');
        publishFailed = true;
      }
    },
    close: () => { if (subscriber.isOpen) subscriber.destroy(); },
  };
}
