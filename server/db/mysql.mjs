import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from 'mysql2/promise';
import { eventDate, sessionWindow } from '../rules.mjs';
import { eventId, migrateMysql } from './migrations.mjs';
import { createConnectionBudget, DatabaseBusyError } from './capacity.mjs';

const positionColumns = 'role, lat, lng, accuracy, updated_at, session_id';

function mysqlQueries(connection) {
  const run = async (sql, ...args) => (await connection.execute(sql, args))[0];
  const get = async (sql, ...args) => (await run(sql, ...args))[0];

  async function ensureSession(sessionId) {
    const known = await get('SELECT 1 FROM event_sessions WHERE event_id = ? AND session_id = ?', eventId, sessionId);
    if (known) return;
    const [day, stage] = sessionId.split(':');
    const session = sessionWindow(day, stage);
    if (session?.id !== sessionId) throw new Error('Invalid session_id');
    await run(`INSERT INTO event_sessions (event_id, session_id, event_date, stage, starts_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE session_id = event_sessions.session_id`,
    eventId, sessionId, day, stage, session.startsAt, session.endsAt);
  }

  async function lockPlayers(ids) {
    for (const id of [...new Set(ids)].sort()) {
      await get('SELECT id FROM users WHERE id = ? FOR UPDATE', id);
    }
  }

  function getPosition(userId) {
    return get(`SELECT ${positionColumns} FROM positions WHERE user_id = ?`, userId);
  }

  async function changeBalance(table, key, calculate) {
    const columns = Object.keys(key);
    const args = Object.values(key);
    const where = columns.map((column) => `${column} = ?`).join(' AND ');
    const select = `SELECT balance, version FROM ${table} WHERE ${where}`;
    let account = await get(select, ...args);
    if (!account) {
      await run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${args.map(() => '?').join(', ')})
        ON DUPLICATE KEY UPDATE version = ${table}.version`, ...args);
      account = await get(select, ...args);
    }
    const balance = calculate(account.balance);
    if (balance === account.balance) return;
    if (!Number.isSafeInteger(balance)) throw new Error('Points balance is outside the supported range');
    const result = await run(`UPDATE ${table} SET balance = ?, version = version + 1 WHERE ${where} AND version = ?`,
      balance, ...args, account.version);
    if (result.affectedRows !== 1) {
      throw Object.assign(new Error('Points account version changed'), { code: 'POINTS_VERSION' });
    }
  }

  return {
    get, all: run, run, ensureSession, getPosition, lockPlayers,
    async lockSettlement(sessionId) {
      await run(`INSERT INTO session_settlements (event_id, session_id) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE settled_at = session_settlements.settled_at`, eventId, sessionId);
      return get('SELECT settled_at FROM session_settlements WHERE event_id = ? AND session_id = ? FOR UPDATE',
        eventId, sessionId);
    },
    async savePosition(userId, { lat, lng, accuracy }, now) {
      const user = await get('SELECT role, stage FROM users WHERE id = ? FOR UPDATE', userId);
      if (!user) return;
      const sessionId = `${eventDate(now)}:${user.stage}`;
      await ensureSession(sessionId);
      await run(`INSERT INTO positions (user_id, event_id, session_id, role, lat, lng, accuracy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) AS incoming ON DUPLICATE KEY UPDATE
        event_id = incoming.event_id, session_id = incoming.session_id, role = incoming.role,
        lat = incoming.lat, lng = incoming.lng, accuracy = incoming.accuracy, updated_at = incoming.updated_at`,
      userId, eventId, sessionId, user.role, lat, lng, accuracy, now);
      return getPosition(userId);
    },
    async claimAction(playerId, requestId, kind) {
      await run(`INSERT INTO actions (player_id, request_id, kind, result) VALUES (?, ?, ?, '')
        ON DUPLICATE KEY UPDATE request_id = actions.request_id`, playerId, requestId, kind);
      return get('SELECT kind, result FROM actions WHERE player_id = ? AND request_id = ? FOR UPDATE', playerId, requestId);
    },
    lockCode: (hash) => get('SELECT * FROM codes WHERE hash = ? FOR UPDATE', hash),
    async lockGrid(sessionId, gridId) {
      await run(`INSERT INTO grid_locks (event_id, session_id, grid_id) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE grid_id = grid_locks.grid_id`, eventId, sessionId, gridId);
      await get('SELECT grid_id FROM grid_locks WHERE event_id = ? AND session_id = ? AND grid_id = ? FOR UPDATE',
        eventId, sessionId, gridId);
    },
    gridHistory: (sessionId, gridId, cutoff) => get(`
      SELECT COUNT(*) AS count, MAX(grid_lock_until) AS until FROM captures
      WHERE event_id = ? AND session_id = ? AND grid_id = ? AND completed_at > ?
    `, eventId, sessionId, gridId, cutoff),
    async lockZone(stage, zoneId) {
      await run(`INSERT INTO cooldowns (stage, zone_id, until) VALUES (?, ?, 0)
        ON DUPLICATE KEY UPDATE zone_id = cooldowns.zone_id`, stage, zoneId);
      await get('SELECT zone_id FROM cooldowns WHERE stage = ? AND zone_id = ? FOR UPDATE', stage, zoneId);
    },
    setZoneCooldown: (stage, zoneId, until) => run(
      'UPDATE cooldowns SET until = ? WHERE stage = ? AND zone_id = ?', until, stage, zoneId,
    ),
    async addPoints(id, playerId, stage, source, amount, now, sessionId = `${eventDate(now)}:${stage}`) {
      await ensureSession(sessionId);
      await changeBalance('points_accounts', { player_id: playerId }, (balance) => balance + amount);
      await changeBalance('points_session_accounts', { event_id: eventId, session_id: sessionId, player_id: playerId },
        (balance) => balance + amount);
      await run(`INSERT INTO points_ledger (id, player_id, event_id, session_id, stage, source, amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, playerId, eventId, sessionId, stage, source, amount, now);
    },
    async rebuildBalances(playerId) {
      const total = await get('SELECT COALESCE(SUM(amount), 0) AS balance FROM points_ledger WHERE player_id = ?', playerId);
      await changeBalance('points_accounts', { player_id: playerId }, () => total.balance);
      const perSession = await run(`SELECT event_id, session_id, SUM(amount) AS balance FROM points_ledger
        WHERE player_id = ? GROUP BY event_id, session_id ORDER BY event_id, session_id`, playerId);
      for (const entry of perSession) {
        await changeBalance('points_session_accounts', {
          event_id: entry.event_id, session_id: entry.session_id, player_id: playerId,
        }, () => entry.balance);
      }
    },
  };
}

export async function openMysqlStore(mysqlUrl, { poolSize = 60 } = {}) {
  const url = new URL(mysqlUrl);
  if (url.protocol !== 'mysql:' || !url.hostname || url.pathname.length <= 1) {
    throw new Error('MYSQL_URL must identify a MySQL database');
  }
  if (!Number.isInteger(poolSize) || poolSize < 32 || poolSize > 80) {
    throw new Error('CAMPUS_MYSQL_POOL_SIZE 必须为 32 至 80 的整数。');
  }
  const budget = createConnectionBudget(poolSize);
  const pool = createPool({
    uri: mysqlUrl, connectTimeout: 5000, connectionLimit: poolSize, waitForConnections: false,
    multipleStatements: false, supportBigNumbers: true, decimalNumbers: true, dateStrings: true,
  });

  async function acquire(lane) {
    const releaseBudget = await budget.acquire(lane);
    try {
      return { connection: await pool.getConnection(), releaseBudget };
    } catch (error) {
      releaseBudget();
      if (error.message === 'No connections available.') throw new DatabaseBusyError(error.message);
      throw error;
    }
  }

  async function read(work, { lane = 'general', timeoutMs } = {}) {
    const { connection, releaseBudget } = await acquire(lane);
    let timer;
    let timedOut = false;
    try {
      if (timeoutMs === undefined) return await work(mysqlQueries(connection));
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new DatabaseBusyError('Database read timed out.'));
          connection.destroy();
        }, timeoutMs);
      });
      return await Promise.race([work(mysqlQueries(connection)), deadline]);
    } finally {
      clearTimeout(timer);
      if (!timedOut) connection.release();
      releaseBudget();
    }
  }

  async function transaction(work, { lane = 'general' } = {}) {
    for (let retries = 0; ; retries++) {
      const { connection, releaseBudget } = await acquire(lane);
      let reusable = true;
      try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        const result = await work(mysqlQueries(connection));
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          connection.destroy();
          reusable = false;
        }
        if (retries >= 3 || (error.errno !== 1213 && error.errno !== 1205)) throw error;
      } finally {
        if (reusable) connection.release();
        releaseBudget();
      }
      await delay(25 * (2 ** retries) + Math.floor(Math.random() * 25));
    }
  }

  try {
    const connection = await pool.getConnection();
    try {
      const [[{ version }]] = await connection.query('SELECT VERSION() AS version');
      const match = /^8\.(\d+)\.(\d+)/.exec(version);
      if (!match || (Number(match[1]) === 0 && Number(match[2]) < 19)) {
        throw new Error('MySQL 8.0.19 or later in the 8.x series is required');
      }
      await migrateMysql(connection);
    } finally {
      connection.release();
    }
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    tables: { users: 'users', ledger: 'points_ledger' },
    read, transaction, capacityStats: budget.stats, close: () => pool.end(),
  };
}
