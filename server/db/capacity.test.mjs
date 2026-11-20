import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectionBudget } from './capacity.mjs';

test('reserves the 40-connection pool by lane and rejects beyond the bounded position queue', async () => {
  const budget = createConnectionBudget(40);
  const initial = await Promise.all([
    ...Array.from({ length: 20 }, () => budget.acquire('position')),
    ...Array.from({ length: 8 }, () => budget.acquire('handshake')),
    ...Array.from({ length: 4 }, () => budget.acquire('broadcast')),
    ...Array.from({ length: 2 }, () => budget.acquire('recovery')),
    ...Array.from({ length: 6 }, () => budget.acquire('general')),
  ]);
  const queued = Array.from({ length: 256 }, () => budget.acquire('position'));
  await assert.rejects(budget.acquire('position'), { code: 'DB_BUSY' });
  const stats = budget.stats();
  assert.deepEqual(Object.fromEntries(Object.entries(stats).map(([lane, row]) => [lane, row.limit])), {
    position: 20, handshake: 8, broadcast: 4, recovery: 2, general: 6,
  });
  assert.equal(Object.values(stats).reduce((sum, row) => sum + row.limit, 0), 40);
  assert.equal(stats.position.queued, 256);
  assert.equal(stats.position.rejected, 1);

  initial.forEach((release) => release());
  await Promise.all(queued.map((request) => request.then((release) => release())));
  assert.equal(budget.stats().position.inUse, 0);
});
