import { lstat, mkdir, mkdtemp, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportRetentionMs } from './retention.mjs';

// The exporter creates one private mkdtemp directory per download, including the owner's PID.
const exportDirectory = /^campus-class-export-([1-9][0-9]{0,9})-[a-zA-Z0-9]{6}$/;
export const exportRootName = 'campus-class-exports';

function ownerHasExited(pid) {
  if (pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'ESRCH';
  }
  return false;
}

function isOwned(stat) {
  return !process.getuid || (stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
}

async function exportRoot(create) {
  const root = join(await realpath(tmpdir()), exportRootName);
  if (create) {
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || !isOwned(stat) || (process.getuid && (stat.mode & 0o077) !== 0) ||
      await realpath(root) !== root) {
    throw new Error('导出临时目录不可用。');
  }
  return root;
}

export async function createExportDirectory() {
  return mkdtemp(join(await exportRoot(true), `campus-class-export-${process.pid}-`));
}

export async function purgeExpiredExports(now = Date.now(), retentionMs = exportRetentionMs) {
  let root;
  try {
    root = await exportRoot(false);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const cutoff = now - retentionMs;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const match = exportDirectory.exec(entry.name);
    if (!entry.isDirectory() || !match || !ownerHasExited(Number(match[1]))) continue;
    const directory = join(root, entry.name);
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || !isOwned(stat) || stat.mtimeMs >= cutoff || dirname(directory) !== root ||
          await realpath(directory) !== directory) continue;
      const files = await readdir(directory);
      if (files.length) {
        if (files.length !== 1 || files[0] !== 'report.xlsx') continue;
        const report = join(directory, 'report.xlsx');
        const file = await lstat(report);
        if (!file.isFile() || file.nlink !== 1 || !isOwned(file) || file.mtimeMs >= cutoff ||
            await realpath(report) !== report) continue;
        await unlink(report);
      }
      await rmdir(directory);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') console.warn('导出临时文件清理失败，稍后可重试。');
    }
  }
}
