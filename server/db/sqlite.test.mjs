import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { openSqliteStore } from '../database.mjs';
import { backupSqlite } from './backup.mjs';

test('SQLite queues readers and writers across a suspended transaction and continues after rollback', async (t) => {
  const store = openSqliteStore(':memory:');
  t.after(store.close);
  await store.transaction((tx) => tx.run('CREATE TABLE queue_probe (value INTEGER)'));

  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const failure = assert.rejects(store.transaction(async (tx) => {
    tx.run('INSERT INTO queue_probe VALUES (1)');
    started.resolve();
    await resume.promise;
    throw new Error('roll back probe');
  }), /roll back probe/);

  await started.promise;
  const sequence = [];
  const read = store.read((query) => {
    sequence.push('read');
    return query.get('SELECT COUNT(*) AS n FROM queue_probe').n;
  });
  const write = store.transaction((tx) => {
    sequence.push('write');
    tx.run('INSERT INTO queue_probe VALUES (2)');
  });

  try {
    await setImmediate();
    assert.deepEqual(sequence, []);
  } finally {
    resume.resolve();
  }
  await failure;
  assert.equal(await read, 0);
  await write;
  assert.deepEqual(sequence, ['read', 'write']);
  assert.equal(await store.read((query) => query.get('SELECT value FROM queue_probe').value), 2);
});

test('online backup includes committed pages still in the WAL and excludes uncommitted changes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'campus-backup-test-'));
  const source = join(dir, 'source.sqlite3');
  const destination = join(dir, 'snapshot.sqlite3');
  const writer = new DatabaseSync(source);
  t.after(() => {
    writer.close();
    for (const name of [source, destination]) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(name + suffix, { force: true });
    }
    rmdirSync(dir);
  });
  writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE example (n INTEGER); PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO example VALUES (1); BEGIN IMMEDIATE; INSERT INTO example VALUES (2);`);
  assert.ok(statSync(`${source}-wal`).size > 0);
  await backupSqlite(source, destination);
  const result = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.deepEqual(result.prepare('SELECT n FROM example').all().map(({ n }) => n), [1]);
  } finally {
    result.close();
  }
});
