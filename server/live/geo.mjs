export const nearbyRadius = 300;

const geoKey = (eventId, role) => `campus-live:${eventId}:geo:${role}`;
const pointKey = (key, member) => `${key}:point:${member}`;

export function isNearby(origin, point) {
  const radians = Math.PI / 180;
  const lat = (point.lat - origin.lat) * radians;
  const lng = (point.lng - origin.lng) * radians;
  const haversine = Math.sin(lat / 2) ** 2 +
    Math.cos(origin.lat * radians) * Math.cos(point.lat * radians) * Math.sin(lng / 2) ** 2;
  return 2 * 6372797.560856 * Math.asin(Math.sqrt(Math.min(1, haversine))) <= nearbyRadius;
}

export function createGeoIndex(redis) {
  let lastWarningAt = -Infinity;
  async function run(work) {
    if (!redis?.isReady) return;
    try {
      return await work(redis.withCommandOptions({ timeout: 400 }));
    } catch {
      const now = Date.now();
      if (redis.isReady && now - lastWarningAt >= 60_000) {
        console.warn('Redis GEO 暂时不可用，使用当前进程的位置。');
        lastWarningAt = now;
      }
    }
  }

  function addPoint(batch, event, point, now) {
    const ttl = point.expiresAt - now;
    if (ttl <= 0) return;
    const key = geoKey(event.id, point.role);
    const { lng, lat, member } = point;
    batch.geoAdd(key, { longitude: lng, latitude: lat, member })
      .pExpire(key, event.endsAt - now)
      .set(pointKey(key, member), JSON.stringify({ ...point, indexedAt: Date.now() }),
        { expiration: { type: 'PX', value: ttl } });
  }

  return {
    write(event, point, now) {
      if (point.expiresAt <= now) return;
      return run((client) => {
        const batch = client.multi();
        addPoint(batch, event, point, now);
        return batch.exec();
      });
    },
    async writeBatch(points, now) {
      const fresh = points.filter(([, point]) => point.expiresAt > now);
      if (!fresh.length) return true;
      return !!await run((client) => {
        const batch = client.multi();
        for (const [event, point] of fresh) addPoint(batch, event, point, now);
        return batch.exec();
      });
    },
    remove(event, point) {
      const key = geoKey(event.id, point.role);
      return run((client) => client.multi().zRem(key, point.member).del(pointKey(key, point.member)).exec());
    },
    async read(event, role) {
      const key = geoKey(event.id, role);
      return await run(async (client) => {
        const members = await client.zRange(key, 0, -1);
        if (!members.length) return [];
        const rows = await client.mGet(members.map((member) => pointKey(key, member)));
        return rows.flatMap((row) => {
          if (!row) return [];
          try {
            const point = JSON.parse(row);
            return point?.id && point.role === role ? [point] : [];
          } catch {
            return [];
          }
        });
      }) ?? [];
    },
  };
}
