export class DatabaseBusyError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'DB_BUSY';
  }
}

export function createConnectionBudget(poolSize) {
  const limits = {
    position: [poolSize - 20, 256, 650],
    handshake: [8, 96, 750],
    broadcast: [4, 32, 350],
    recovery: [2, 16, 500],
    general: [6, 128, 2500],
  };
  const lanes = Object.fromEntries(Object.entries(limits).map(([name, [limit, maxQueue, waitMs]]) =>
    [name, createLane(limit, maxQueue, waitMs)]));
  return {
    acquire: (lane) => lanes[lane].acquire(),
    stats: () => Object.fromEntries(Object.entries(lanes).map(([name, lane]) => [name, lane.stats()])),
  };
}

function createLane(limit, maxQueue, waitMs) {
  const queue = new Set();
  let inUse = 0;
  let rejected = 0;
  let timedOut = 0;
  let peakInUse = 0;
  let peakQueued = 0;

  function expire(waiter) {
    clearTimeout(waiter.timer);
    queue.delete(waiter);
    timedOut++;
    waiter.reject(new DatabaseBusyError('Database queue timed out.'));
  }

  function release() {
    for (const waiter of queue) {
      if (performance.now() >= waiter.deadline) {
        expire(waiter);
        continue;
      }
      clearTimeout(waiter.timer);
      queue.delete(waiter);
      waiter.resolve(release);
      return;
    }
    inUse--;
  }

  function acquire() {
    if (inUse < limit) {
      inUse++;
      peakInUse = Math.max(peakInUse, inUse);
      return Promise.resolve(release);
    }
    if (queue.size >= maxQueue) {
      rejected++;
      return Promise.reject(new DatabaseBusyError('Database queue is full.'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, deadline: performance.now() + waitMs };
      waiter.timer = setTimeout(() => expire(waiter), waitMs);
      queue.add(waiter);
      peakQueued = Math.max(peakQueued, queue.size);
    });
  }

  return { acquire, stats: () => ({ limit, inUse, queued: queue.size, rejected, timedOut, peakInUse, peakQueued }) };
}
