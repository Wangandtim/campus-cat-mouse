import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLivePlayerCache } from './player-cache.mjs';

test('bounds combined live-state reads to six batches across handshake, broadcast, and recovery',
  { timeout: 5000 }, async () => {
    let active = 0;
    let peak = 0;
    const gates = [];
    const started = Promise.withResolvers();
    const cache = createLivePlayerCache(async (ids) => {
      active++;
      peak = Math.max(peak, active);
      const gate = Promise.withResolvers();
      gates.push(gate);
      if (gates.length === 6) started.resolve();
      await gate.promise;
      active--;
      return ids.map((id) => ({ id, role: 'cat', stage: 'morning', sharing: true }));
    });
    const work = [];
    for (const [lane, batches] of [['handshake', 3], ['broadcast', 2], ['recovery', 1]]) {
      for (let batch = 0; batch < batches; batch++) {
        for (let index = 0; index < 64; index++) {
          const id = `${lane}-${batch}-${index}`;
          work.push(cache.get(id, id, 'session', Date.now(), lane));
        }
      }
    }

    await started.promise;
    assert.equal(peak, 6);
    gates.forEach((gate) => gate.resolve());
    await Promise.all(work);
    assert.equal(peak, 6);
    assert.equal(active, 0);
  });

test('times out a slow batch without caching its late result or holding a batch slot forever',
  { timeout: 5000 }, async () => {
    let calls = 0;
    let active = 0;
    const slow = Promise.withResolvers();
    const cache = createLivePlayerCache(async (ids) => {
      calls++;
      active++;
      if (calls === 1) {
        await slow.promise;
        active--;
        return ids.map((id) => ({ id, role: 'cat', stage: 'morning', sharing: true }));
      }
      active--;
      return ids.map((id) => ({ id, role: 'mouse', stage: 'evening', sharing: true }));
    });
    const pending = cache.get('public-player', 'player', 'session', Date.now(), 'broadcast');
    await assert.rejects(pending, { code: 'DB_BUSY' });
    assert.equal(active, 1, 'the active batch remains accounted for until its query settles');
    slow.resolve();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal((await cache.get('public-player', 'player', 'session', Date.now(), 'broadcast')).value.role, 'mouse');
    assert.equal(calls, 2);
    assert.equal(active, 0);
  });
