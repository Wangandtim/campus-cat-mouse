import { createClient } from 'redis';

const maxReconnectAttempts = 8;
const maxReconnectDelayMs = 2000;
const maxReconnectJitterMs = 200;

export async function connectRedis(redisUrl) {
  const url = redisUrl?.trim();
  if (!url) return null;

  let startupChecked = false;
  const client = createClient({
    url,
    socket: {
      reconnectStrategy(retries) {
        if (!startupChecked) return false;
        if (retries >= maxReconnectAttempts) {
          console.error('Redis 重连次数已耗尽。');
          return false;
        }
        const backoffMs = Math.min(50 * 2 ** retries, maxReconnectDelayMs - maxReconnectJitterMs);
        const jitterMs = Math.floor(Math.random() * (maxReconnectJitterMs + 1));
        return backoffMs + jitterMs;
      },
    },
  });
  client.on('error', () => console.error('Redis 连接异常。'));

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
