import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { audit, checkedDate } from '../admin/common.mjs';
import { AuthError } from '../auth/error.mjs';
import { GameError } from '../game.mjs';
import { eventDate } from '../rules.mjs';
import { createExportDirectory } from '../security/export-cleanup.mjs';
import { readClassReport } from './report.mjs';
import { classSheets, createWorkbook } from './xlsx.mjs';

const anonymousActor = { kind: 'system', id: 'anonymous' };
const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function downloadClassReport(store, clock, res, authenticate, readBody) {
  const exportId = randomUUID();
  let actor = anonymousActor;
  let day;
  let scope = 'day';
  let phase = 'authorization';
  function record(action, details) {
    const now = clock();
    return store.transaction((tx) => audit(tx, actor, day ?? eventDate(now), action, now, null, { exportId, scope, ...details }));
  }

  try {
    actor = await authenticate();
    phase = 'request';
    const body = await readBody();
    scope = body.scope === 'total' ? 'total' : 'day';
    if (body.scope !== undefined && !['day', 'total'].includes(body.scope)) {
      throw new AuthError('EXPORT_SCOPE', '导出范围无效。', 422);
    }
    day = checkedDate(body.eventDate);
    phase = 'generate';
    const rows = await readClassReport(store, day, scope);
    const sheets = classSheets(rows);
    const counts = { rows: rows.length, classes: sheets.length - 1, scope };
    const directory = await createExportDirectory();
    const temporaryFile = join(directory, 'report.xlsx');
    try {
      const workbook = createWorkbook(sheets);
      await writeFile(temporaryFile, workbook, { mode: 0o600, flag: 'wx' });
      phase = 'audit';
      // The audit must be durable before the response can disclose student data.
      await record('export.ready', counts);
      phase = 'download';
      if (res.destroyed) throw new Error('Download disconnected.');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="campus-class-${scope}-${day}.xlsx"`,
        'Content-Length': workbook.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(createReadStream(temporaryFile), res);
      phase = 'cleanup';
    } finally {
      await rm(temporaryFile, { force: true });
      await rmdir(directory);
    }
    phase = 'audit';
    await record('export.succeeded', counts);
  } catch (error) {
    const known = error instanceof AuthError || error instanceof GameError;
    try {
      await record('export.failed', { phase, code: known ? error.code : 'EXPORT' });
    } catch {
      console.error('Class export audit write failed.');
    }
    if (res.destroyed || res.headersSent) {
      if (!res.writableFinished) res.destroy();
      return;
    }
    if (known) throw error;
    throw new AuthError('EXPORT', '导出暂时无法完成，请稍后重试。', 500);
  }
}
