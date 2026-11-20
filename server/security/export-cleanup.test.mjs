import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { exportRootName } from './export-cleanup.mjs';
import { exportRetentionMs } from './retention.mjs';

const exporterUrl = new URL('../export/download.mjs', import.meta.url).href;
const sweeperUrl = new URL('./export-cleanup.mjs', import.meta.url).href;
const retentionUrl = new URL('./retention.mjs', import.meta.url).href;
const phone = '13900001234';
const email = 'export-sample@example.invalid';

function hasContactDetails(workbook) {
  let offset = 0;
  while (workbook.readUInt32LE(offset) === 0x04034b50) {
    const size = workbook.readUInt32LE(offset + 18);
    const data = offset + 30 + workbook.readUInt16LE(offset + 26) + workbook.readUInt16LE(offset + 28);
    const xml = inflateRawSync(workbook.subarray(data, data + size)).toString('utf8');
    if (xml.includes(phone) && xml.includes(email)) return true;
    offset = data + size;
  }
  return false;
}

test('next startup only removes aged abandoned export directories and never follows links', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'campus-export-sweep-test-'));
  const temp = join(directory, 'temp');
  const root = join(temp, exportRootName);
  const outside = join(directory, 'outside');
  await mkdir(temp);
  await mkdir(outside);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp };
  const now = Date.now();
  const old = new Date(now - exportRetentionMs - 60_000);
  const recent = new Date(now - exportRetentionMs + 60_000);

  const exporter = spawn(process.execPath, ['--input-type=module', '-e', `
    import { downloadClassReport } from ${JSON.stringify(exporterUrl)};
    const store = {
      tables: { users: 'players', ledger: 'ledger' },
      read: (work) => work({ all: () => [{
        id: 'student', name: '测试学生', studentId: 'test-01', grade: '2026', college: '测试学院', className: '测试班',
        phone: ${JSON.stringify(phone)}, email: ${JSON.stringify(email)},
        captures: 0, meters: 0, points: 0, sessions: 0,
      }] }),
      transaction: (work) => work({ run(_sql, _id, _event, _date, _kind, _actor, action) {
        if (action !== 'export.ready') {
          process.send(action);
          return;
        }
        process.send('written');
        return new Promise(() => {});
      } }),
    };
    setInterval(() => {}, 1000);
    await downloadClassReport(store, Date.now, {}, () => ({ kind: 'teacher', id: 'test' }),
      () => ({ eventDate: '2026-11-23' }));
  `], { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  const stopped = once(exporter, 'exit');
  t.after(() => exporter.kill('SIGKILL'));
  const [message] = await once(exporter, 'message', { signal: AbortSignal.timeout(4000) });
  assert.equal(message, 'written');
  const [exportName] = await readdir(root);
  assert.match(exportName, new RegExp(`^campus-class-export-${exporter.pid}-[A-Za-z0-9]{6}$`));
  const exportPath = join(root, exportName);
  const report = join(exportPath, 'report.xlsx');
  assert.equal(hasContactDetails(await readFile(report)), true);

  async function startupSweep(seconds = '') {
    const startup = spawn(process.execPath, ['--input-type=module', '-e', `
      import { purgeExpiredExports } from ${JSON.stringify(sweeperUrl)};
      import { retentionSettings } from ${JSON.stringify(retentionUrl)};
      const retention = retentionSettings(process.env);
      await purgeExpiredExports(${now}, retention.exportRetentionMs);
    `], { env: { ...env, CAMPUS_EXPORT_RETENTION_SECONDS: seconds }, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    const [code] = await once(startup, 'exit');
    assert.equal(code, 0);
  }

  await utimes(report, old, old);
  await utimes(exportPath, old, old);
  await startupSweep();
  assert.ok((await lstat(report)).isFile(), 'a live export is kept even when its timestamps are old');

  exporter.kill('SIGKILL');
  await stopped;
  const prefix = `campus-class-export-${exporter.pid}-`;
  const outsideExport = join(temp, prefix + 'Other1');
  await mkdir(outsideExport);
  await utimes(outsideExport, old, old);
  const fresh = join(root, prefix + 'Fresh0');
  const freshReport = join(fresh, 'report.xlsx');
  await mkdir(fresh);
  await writeFile(freshReport, 'fresh');
  await utimes(fresh, old, old);
  await utimes(freshReport, recent, recent);
  const unknown = join(root, prefix + 'Other0');
  await mkdir(unknown);
  await writeFile(join(unknown, 'other.txt'), 'unrecognized file');
  await utimes(unknown, old, old);
  const empty = join(root, prefix + 'Empty0');
  await mkdir(empty);
  await utimes(empty, old, old);
  const sentinel = join(outside, 'report.xlsx');
  await writeFile(sentinel, 'outside test data');
  await utimes(sentinel, old, old);
  await utimes(outside, old, old);
  const directoryLink = join(root, prefix + 'Link00');
  await symlink(outside, directoryLink, 'junction');
  const fileLinkDirectory = join(root, prefix + 'Link01');
  await mkdir(fileLinkDirectory);
  const fileLink = join(fileLinkDirectory, 'report.xlsx');
  await symlink(outside, fileLink, 'junction');
  await utimes(fileLinkDirectory, old, old);

  await startupSweep();
  assert.equal(dirname(exportPath), root);
  await assert.rejects(readFile(report), { code: 'ENOENT' });
  await assert.rejects(lstat(exportPath), { code: 'ENOENT' });
  await assert.rejects(lstat(empty), { code: 'ENOENT' });
  for (const kept of [freshReport, unknown, sentinel, directoryLink, fileLink, outsideExport]) await lstat(kept);

  await startupSweep('1800');
  await assert.rejects(lstat(freshReport), { code: 'ENOENT' });
  assert.ok((await lstat(outsideExport)).isDirectory());
});
