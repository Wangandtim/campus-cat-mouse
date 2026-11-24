import { DatabaseBusyError } from '../db/capacity.mjs';

const cacheMs = 30_000;
const batchSize = 64;
const batchDeadlineMs = 1000;

export function createLivePlayerCache(load) {
  const entries = new Map();
  const lanes = {};
  // These limits add up to six live-state query batches across all request types.
  for (const [name, concurrency] of Object.entries({ handshake: 3, broadcast: 2, recovery: 1 })) {
    const queue = [];
    let active = 0;
    let timer;

    function schedule() {
      if (queue.length && active < concurrency && !timer) timer = setTimeout(dispatch, 5);
    }

    async function run(batch) {
      const now = batch[0].now;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        batch.forEach(({ reject }) => reject(new DatabaseBusyError('Live player batch timed out.')));
      }, batchDeadlineMs);
      try {
        const rows = await load(batch.map(({ playerId }) => playerId), now, name);
        if (timedOut) return;
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const entry of batch) {
          if (entries.get(entry.key) !== entry) {
            entry.reject(new DatabaseBusyError('Live player state changed.'));
            continue;
          }
          entry.value = byId.get(entry.playerId);
          entry.until = performance.now() + cacheMs;
          entry.resolve(entry);
        }
      } catch (error) {
        if (!timedOut) batch.forEach(({ reject }) => reject(error));
      } finally {
        clearTimeout(timer);
        active--;
        schedule();
      }
    }

    function dispatch() {
      timer = undefined;
      while (queue.length && active < concurrency) {
        active++;
        void run(queue.splice(0, batchSize));
      }
    }
    lanes[name] = (entry) => {
      queue.push(entry);
      schedule();
    };
  }

  function peek(key, sessionId) {
    const entry = entries.get(key);
    if (entry?.sessionId === sessionId && entry.until > performance.now()) return entry;
  }

  return {
    peek,
    get(key, playerId, sessionId, now, lane, { refresh = false } = {}) {
      const cached = peek(key, sessionId);
      if (cached && !refresh) return Promise.resolve(cached);
      const pending = entries.get(key);
      if (pending?.sessionId === sessionId && pending.promise) return pending.promise;
      const entry = { key, playerId, sessionId, now, until: 0 };
      entries.set(key, entry);
      const request = new Promise((resolve, reject) => {
        Object.assign(entry, { resolve, reject });
        lanes[lane](entry);
      });
      entry.promise = request.catch((error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }).finally(() => {
        entry.promise = entry.resolve = entry.reject = undefined;
      });
      return entry.promise;
    },
    invalidate(key) { entries.delete(key); },
    invalidateAll() { entries.clear(); },
    prune() {
      const now = performance.now();
      for (const [key, entry] of entries) {
        if (!entry.promise && entry.until <= now) entries.delete(key);
      }
    },
  };
}
