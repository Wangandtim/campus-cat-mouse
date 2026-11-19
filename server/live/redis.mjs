import { createClient } from 'redis';

export async function connectRedis(redisUrl) {
  const url = redisUrl?.trim();
  if (!url) return null;

  const client = createClient({ url, socket: { reconnectStrategy: false } });
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
    return client;
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
