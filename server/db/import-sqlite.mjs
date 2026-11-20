import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { eventDate } from '../rules.mjs';
import { eventId } from './migrations.mjs';
import { openMysqlStore } from './mysql.mjs';

function conflict(table, key) {
  return Object.assign(new Error(`Unique key conflict in ${table} (${key})`), { code: 'SQLITE_IMPORT_CONFLICT' });
}

async function insertOrVerify(tx, table, primary, row) {
  const columns = Object.keys(row);
  const values = Object.values(row);
  const where = primary.map((column) => `${column} = ?`).join(' AND ');
  const existing = await tx.get(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${where} FOR UPDATE`,
    ...primary.map((column) => row[column]));
  if (existing) {
    if (columns.some((column) => column === 'details' && table === 'audit_logs'
      ? !isDeepStrictEqual(jsonValue(existing[column]), jsonValue(row[column]))
      : existing[column] !== row[column])) throw conflict(table, primary.join(', '));
    return 0;
  }
  try {
    await tx.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...values);
    return 1;
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      const key = /for key '([^']+)'/.exec(error.sqlMessage)?.[1] ?? primary.join(', ');
      throw conflict(table, key);
    }
    throw error;
  }
}

const presentSession = (id) => id?.trim() ? id : null;
const jsonValue = (value) => typeof value === 'string' ? JSON.parse(value) : value;

export async function importSqlite(snapshot, store) {
  const source = new DatabaseSync(snapshot, { readOnly: true, timeout: 3000 });
  try {
    const exists = source.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    if (!exists.get('players')) throw new Error('The SQLite snapshot has no players table');

    return await store.transaction(async (tx) => {
      const counts = { skippedPositions: 0 };
      const importedSessions = new Set();

      async function ensureSession(sessionId) {
        if (sessionId && !importedSessions.has(sessionId)) {
          await tx.ensureSession(sessionId);
          importedSessions.add(sessionId);
        }
      }

      async function transfer(from, to, primary, columns, map = (row) => row) {
        counts[to] = 0;
        if (!exists.get(from)) return;
        const rows = source.prepare(`SELECT * FROM ${from} ORDER BY ${primary.join(', ')}`).iterate();
        for (const row of rows) {
          const mapped = await map(row);
          if (!mapped) continue;
          const record = Object.fromEntries(columns.map((column) => [column, mapped[column] ?? null]));
          counts[to] += await insertOrVerify(tx, to, primary, record);
        }
      }

      // Preserve the runtime lock order for action keys and player rows.
      await transfer('actions', 'actions', ['player_id', 'request_id'], ['player_id', 'request_id', 'kind', 'result']);
      await transfer('players', 'users', ['id'],
        ['id', 'nickname', 'role', 'stage', 'sharing', 'created_at', 'openid', 'name', 'student_id',
          'grade', 'college', 'class_name', 'phone', 'email', 'gender'],
      (row) => ({ ...row, gender: row.gender ?? 'unknown' }));
      await transfer('event_registrations', 'event_registrations', ['user_id', 'event_id'],
        ['user_id', 'event_id', 'created_at']);
      await transfer('event_sessions', 'event_sessions', ['event_id', 'session_id'],
        ['event_id', 'session_id', 'event_date', 'stage', 'starts_at', 'ends_at']);
      await transfer('progress', 'progress', ['player_id', 'stage'], ['player_id', 'stage', 'meters', 'last_walk', 'tracking']);
      await transfer('codes', 'codes', ['hash'], ['hash', 'player_id', 'stage', 'mouse_id', 'purpose', 'expires_at', 'used']);
      await transfer('cooldowns', 'cooldowns', ['stage', 'zone_id'], ['stage', 'zone_id', 'until']);
      await transfer('positions', 'positions', ['user_id'],
        ['user_id', 'event_id', 'session_id', 'role', 'lat', 'lng', 'accuracy', 'updated_at'], async (row) => {
          const sessionId = presentSession(row.session_id);
          if (!sessionId) {
            counts.skippedPositions++;
            return null;
          }
          await ensureSession(sessionId);
          return { ...row, event_id: eventId, session_id: sessionId };
        });
      await transfer('captures', 'captures', ['id'],
        ['id', 'player_id', 'event_id', 'stage', 'mouse_id', 'zone_id', 'completed_at', 'meters', 'awarded',
          'session_id', 'mouse_player_id', 'grid_id', 'grid_lock_until'], async (row) => {
          const sessionId = presentSession(row.session_id);
          await ensureSession(sessionId);
          return { ...row, event_id: eventId, session_id: sessionId };
        });
      await transfer('points', 'points_ledger', ['id'],
        ['id', 'player_id', 'event_id', 'session_id', 'stage', 'source', 'amount', 'created_at'], async (row) => {
          const capture = row.source === 'capture' && await tx.get('SELECT session_id FROM captures WHERE id = ?', row.id);
          const sessionId = row.session_id ?? capture?.session_id ?? `${eventDate(row.created_at)}:${row.stage}`;
          await ensureSession(sessionId);
          return { ...row, event_id: eventId, session_id: sessionId };
        });
      await transfer('participation_sessions', 'participation_sessions', ['event_id', 'session_id', 'player_id'],
        ['event_id', 'session_id', 'player_id', 'role', 'gender', 'started_at', 'ended_at', 'status', 'status_at',
          'paused_total_seconds', 'valid_meters', 'required_meters', 'max_seconds', 'completed_at', 'last_sample_at',
          'last_movement_at', 'last_capture_meters', 'anchor_lat', 'anchor_lng', 'gap_started_at', 'gap_reason', 'data_gap_seconds']);
      await transfer('session_settlements', 'session_settlements', ['event_id', 'session_id'],
        ['event_id', 'session_id', 'settled_at']);
      await transfer('audit_logs', 'audit_logs', ['id'],
        ['id', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'details', 'created_at']);

      for (const { id } of source.prepare('SELECT id FROM players ORDER BY id').iterate()) {
        await tx.rebuildBalances(id);
      }
      return counts;
    });
  } finally {
    source.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let store;
  try {
    if (!process.argv[2] || !process.env.MYSQL_URL?.trim()) {
      throw new Error('请提供 SQLite 备份路径，并设置 MYSQL_URL');
    }
    const snapshot = resolve(process.argv[2]);
    if (snapshot === resolve('.campus/preview.sqlite3')) throw new Error('请先运行 pnpm db:backup，并传入备份路径');
    store = await openMysqlStore(process.env.MYSQL_URL.trim());
    console.log(JSON.stringify(await importSqlite(snapshot, store)));
  } catch (error) {
    const details = error.code === 'SQLITE_IMPORT_CONFLICT' ? error.message : error.code ?? error.message;
    console.error('SQLite → MySQL 迁移失败', details);
    process.exitCode = 1;
  } finally {
    await store?.close();
  }
}
