import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export async function backupSqlite(filename, destination) {
  const source = new DatabaseSync(filename, { readOnly: true, timeout: 3000 });
  try {
    // Reserve a new destination. The SQLite backup API can overwrite an existing file.
    const file = await open(destination, 'wx');
    try {
      await file.close();
      await backup(source, destination);
      const snapshot = new DatabaseSync(destination, { readOnly: true });
      try {
        const result = snapshot.prepare('PRAGMA integrity_check').all();
        if (result.length !== 1 || result[0].integrity_check !== 'ok') {
          throw new Error('SQLite snapshot failed integrity_check');
        }
      } finally {
        snapshot.close();
      }
    } catch (error) {
      await unlink(destination).catch(() => {});
      throw error;
    }
  } finally {
    source.close();
  }
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = resolve(process.argv[2] ?? '.campus/preview.sqlite3');
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const destination = resolve(process.argv[3] ?? `${source}.backup-${timestamp}.sqlite3`);
  try {
    console.log(await backupSqlite(source, destination));
  } catch (error) {
    console.error('SQLite 备份失败', error.code ?? error.message);
    process.exitCode = 1;
  }
}
