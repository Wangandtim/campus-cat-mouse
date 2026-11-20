import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { activeEvent, eventDate, sessionWindow } from './rules.mjs';
import { eventId } from './db/migrations.mjs';
import { eventSessionsTable, participationTables } from './db/participation-schema.mjs';
import { participationOf, recordMileage } from './db/participation.mjs';
import { migrateSqliteAdmin } from './admin/schema.mjs';

const captureTable = `
  CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    stage TEXT NOT NULL,
    mouse_id INTEGER NOT NULL,
    zone_id TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    meters INTEGER NOT NULL,
    awarded INTEGER NOT NULL,
    session_id TEXT,
    mouse_player_id TEXT REFERENCES players(id),
    grid_id TEXT,
    grid_lock_until INTEGER,
    CHECK (session_id IS NULL OR (mouse_player_id IS NOT NULL AND grid_id IS NOT NULL))
  );
`;

function migrateSqliteAuth(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(players)').all().map(({ name }) => name));
  for (const name of ['openid', 'name', 'student_id', 'grade', 'college', 'class_name', 'phone', 'email']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE players ADD COLUMN ${name} TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_openid_unique ON players(openid);
    CREATE UNIQUE INDEX IF NOT EXISTS users_student_id_unique ON players(student_id);
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT NOT NULL PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states(expires_at);
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id TEXT NOT NULL PRIMARY KEY,
      openid TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pending_registrations_expiry ON pending_registrations(expires_at);
    CREATE TABLE IF NOT EXISTS event_registrations (
      user_id TEXT NOT NULL REFERENCES players(id),
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, event_id)
    );
  `);
}

function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cat',
      stage TEXT NOT NULL DEFAULT 'evening',
      sharing INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      user_id TEXT NOT NULL PRIMARY KEY REFERENCES players(id),
      role TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      session_id TEXT
    );
    CREATE TABLE IF NOT EXISTS progress (
      player_id TEXT NOT NULL REFERENCES players(id),
      stage TEXT NOT NULL,
      meters INTEGER NOT NULL,
      last_walk INTEGER NOT NULL,
      tracking INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (player_id, stage)
    );
    ${captureTable}
    CREATE TABLE IF NOT EXISTS points (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      stage TEXT NOT NULL,
      source TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS points_by_player ON points(player_id, stage);
    CREATE TABLE IF NOT EXISTS codes (
      hash TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      stage TEXT NOT NULL,
      mouse_id INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cooldowns (
      stage TEXT NOT NULL,
      zone_id TEXT NOT NULL,
      until INTEGER NOT NULL,
      PRIMARY KEY (stage, zone_id)
    );
    CREATE TABLE IF NOT EXISTS actions (
      player_id TEXT NOT NULL REFERENCES players(id),
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY (player_id, request_id)
    );
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    migrateSqliteAuth(db);
    if (!db.prepare("SELECT 1 FROM pragma_table_info('players') WHERE name = 'gender'").get()) {
      db.exec(`ALTER TABLE players ADD COLUMN gender TEXT NOT NULL DEFAULT 'unknown'
        CHECK (gender IN ('unknown', 'male', 'female'))`);
    }
    const hasSession = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'session_id'");
    if (!hasSession.get('positions')) db.exec('ALTER TABLE positions ADD COLUMN session_id TEXT');
    if (!hasSession.get('captures')) {
      // Existing records have a display mouse number but no issuing player ID.
      const legacyColumns = 'id, player_id, stage, mouse_id, zone_id, completed_at, meters, awarded';
      db.exec(`
        ALTER TABLE captures RENAME TO legacy_captures;
        ${captureTable}
        INSERT INTO captures (${legacyColumns}) SELECT ${legacyColumns} FROM legacy_captures;
        DROP TABLE legacy_captures;
      `);
    }
    if (!hasSession.get('points')) {
      db.exec(`ALTER TABLE points ADD COLUMN session_id TEXT;
        UPDATE points SET session_id = COALESCE(
          (SELECT session_id FROM captures WHERE captures.id = points.id AND points.source = 'capture'),
          strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+08:00') || ':' || stage
        )`);
    }
    db.exec(`
      ${eventSessionsTable()};
      ${participationTables('players').join(';\n')};
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY,
        actor_user_id TEXT REFERENCES players(id),
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        details TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS points_by_player_session ON points(player_id, session_id);
    `);
    migrateSqliteAdmin(db);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS captures_by_sample
        ON captures(player_id, stage, mouse_id) WHERE session_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS captures_by_mouse
        ON captures(session_id, player_id, mouse_player_id) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS captures_by_player_stage
        ON captures(player_id, stage, completed_at DESC, meters DESC);
      CREATE INDEX IF NOT EXISTS captures_by_zone
        ON captures(stage, zone_id, completed_at) WHERE session_id IS NULL;
      CREATE INDEX IF NOT EXISTS captures_by_grid
        ON captures(session_id, grid_id, completed_at) WHERE session_id IS NOT NULL;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

export function openSqliteStore(filename) {
  const db = openDatabase(filename);
  db.exec('PRAGMA busy_timeout = 0');
  let tail = Promise.resolve();
  let closing;

  function enqueue(work) {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function beginWrite() {
    const deadline = performance.now() + 3000;
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        if ((error.errcode & 0xff) !== 5 || performance.now() >= deadline) throw error;
        // A synchronous busy wait would also block a writer on another connection in this process.
        await delay(20);
      }
    }
  }

  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const read = db.prepare(`
    SELECT role, lat, lng, accuracy, updated_at, session_id FROM positions WHERE user_id = ?
  `);
  const write = db.prepare(`
    INSERT INTO positions (user_id, role, lat, lng, accuracy, updated_at, session_id)
    SELECT id, role, ?, ?, ?, ?, ? || ':' || stage FROM players WHERE id = ?
    ON CONFLICT(user_id) DO UPDATE SET
      role = excluded.role,
      lat = excluded.lat,
      lng = excluded.lng,
      accuracy = excluded.accuracy,
      updated_at = excluded.updated_at,
      session_id = excluded.session_id
    RETURNING role, lat, lng, accuracy, updated_at, session_id
  `);
  const queries = {
    get, all, run,
    ensureSession(sessionId) {
      const [day, stage] = sessionId.split(':');
      const session = sessionWindow(day, stage);
      if (session?.id !== sessionId) throw new Error('Invalid session_id');
      run(`INSERT INTO event_sessions (event_id, session_id, event_date, stage, starts_at, ends_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, session_id) DO NOTHING`,
      eventId, sessionId, day, stage, session.startsAt, session.endsAt);
    },
    lockSettlement(sessionId) {
      run(`INSERT INTO session_settlements (event_id, session_id) VALUES (?, ?)
        ON CONFLICT(event_id, session_id) DO NOTHING`, eventId, sessionId);
      return get('SELECT settled_at FROM session_settlements WHERE event_id = ? AND session_id = ?', eventId, sessionId);
    },
    getPosition: (userId) => read.get(userId),
    savePosition: (userId, { lat, lng, accuracy }, now) => write.get(lat, lng, accuracy, now, eventDate(now), userId),
    claimAction(playerId, requestId, kind) {
      run(`INSERT INTO actions (player_id, request_id, kind, result) VALUES (?, ?, ?, '')
        ON CONFLICT(player_id, request_id) DO NOTHING`, playerId, requestId, kind);
      return get('SELECT kind, result FROM actions WHERE player_id = ? AND request_id = ?', playerId, requestId);
    },
    // BEGIN IMMEDIATE already serializes all writers for the preview database.
    lockPlayers() {},
    lockGrid() {},
    lockZone() {},
    lockCode: (hash) => get('SELECT * FROM codes WHERE hash = ?', hash),
    gridHistory: (sessionId, gridId, cutoff) => get(`
      SELECT COUNT(*) AS count, MAX(grid_lock_until) AS until FROM captures
      WHERE session_id = ? AND grid_id = ? AND completed_at > ?
    `, sessionId, gridId, cutoff),
    setZoneCooldown: (stage, zoneId, until) => run(`
      INSERT INTO cooldowns (stage, zone_id, until) VALUES (?, ?, ?)
      ON CONFLICT(stage, zone_id) DO UPDATE SET until = excluded.until
    `, stage, zoneId, until),
    addPoints: (id, playerId, stage, source, amount, now, sessionId = null) => run(
      'INSERT INTO points (id, player_id, stage, source, amount, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, playerId, stage, source, amount, now, sessionId,
    ),
  };

  return {
    tables: { users: 'players', ledger: 'points' },
    read: (work) => enqueue(() => work(queries)),
    transaction: (work) => enqueue(async () => {
      await beginWrite();
      try {
        const result = await work(queries);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => closing ??= enqueue(() => db.close()),
  };
}

export function openPositionStore(store, clock = Date.now) {
  return {
    get: (userId) => store.read(async (query) => await query.getPosition(userId) ?? null),
    save: (userId, coordinates, now = clock(), sessionId, reportedGap, { requireSharing = false } = {}) => store.transaction(async (tx) => {
      let player;
      if (requireSharing || sessionId !== undefined) {
        await tx.lockPlayers([userId]);
        player = await tx.get(`SELECT stage, sharing, openid IS NOT NULL AS registered
          FROM ${store.tables.users} WHERE id = ?`, userId);
        if (requireSharing && !player?.sharing) return;
      }
      if (sessionId !== undefined) {
        const session = player?.registered && activeEvent(player.stage, clock());
        if (!session || session.id !== sessionId || now < session.startsAt || now >= session.endsAt) return;
        const row = await participationOf(tx, sessionId, userId);
        if (!await recordMileage(tx, row, coordinates, now, reportedGap)) return;
      }
      return tx.savePosition(userId, coordinates, now);
    }, { lane: 'position' }),
  };
}
