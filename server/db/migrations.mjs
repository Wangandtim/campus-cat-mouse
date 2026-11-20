import { eventSessionsTable, participationTables } from './participation-schema.mjs';
import { migrateMysqlAdmin, migrateMysqlAdminEventSettings } from '../admin/schema.mjs';

export const eventId = 'campus-cat-mouse';

const tableOptions = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
const initialTables = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    nickname VARCHAR(64) NOT NULL,
    role VARCHAR(8) NOT NULL DEFAULT 'cat',
    stage VARCHAR(16) NOT NULL DEFAULT 'evening',
    sharing TINYINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    name VARCHAR(64),
    student_id VARCHAR(64),
    grade VARCHAR(32),
    college VARCHAR(120),
    class_name VARCHAR(120),
    phone VARCHAR(32),
    email VARCHAR(254)
  ) ${tableOptions}`,
  eventSessionsTable(tableOptions),
  `CREATE TABLE IF NOT EXISTS positions (
    user_id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(32) NOT NULL,
    role VARCHAR(8) NOT NULL,
    lat DOUBLE NOT NULL,
    lng DOUBLE NOT NULL,
    accuracy DOUBLE NOT NULL,
    updated_at BIGINT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (event_id, session_id) REFERENCES event_sessions(event_id, session_id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS captures (
    id VARCHAR(64) PRIMARY KEY,
    player_id VARCHAR(64) NOT NULL,
    event_id VARCHAR(64) NOT NULL DEFAULT '${eventId}',
    stage VARCHAR(16) NOT NULL,
    mouse_id SMALLINT UNSIGNED NOT NULL,
    zone_id VARCHAR(64) NOT NULL,
    completed_at BIGINT NOT NULL,
    meters INT NOT NULL,
    awarded INT NOT NULL,
    session_id VARCHAR(32),
    mouse_player_id VARCHAR(64),
    grid_id VARCHAR(32),
    grid_lock_until BIGINT,
    legacy_mouse_number SMALLINT UNSIGNED GENERATED ALWAYS AS (
      CASE WHEN session_id IS NULL THEN mouse_id ELSE NULL END
    ) STORED,
    UNIQUE KEY captures_by_mouse (event_id, session_id, player_id, mouse_player_id),
    UNIQUE KEY captures_by_sample (event_id, player_id, stage, legacy_mouse_number),
    KEY captures_by_player_stage (player_id, stage, completed_at DESC, meters DESC),
    KEY captures_by_zone (session_id, stage, zone_id, completed_at),
    KEY captures_by_grid (event_id, session_id, grid_id, completed_at),
    FOREIGN KEY (player_id) REFERENCES users(id),
    FOREIGN KEY (mouse_player_id) REFERENCES users(id),
    FOREIGN KEY (event_id, session_id) REFERENCES event_sessions(event_id, session_id),
    CHECK ((session_id IS NULL AND mouse_player_id IS NULL) OR
      (session_id IS NOT NULL AND session_id <> '' AND mouse_player_id IS NOT NULL AND mouse_player_id <> ''
       AND grid_id IS NOT NULL AND grid_id <> ''))
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS grid_locks (
    event_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(32) NOT NULL,
    grid_id VARCHAR(32) NOT NULL,
    PRIMARY KEY (event_id, session_id, grid_id),
    FOREIGN KEY (event_id, session_id) REFERENCES event_sessions(event_id, session_id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS points_ledger (
    id VARCHAR(64) PRIMARY KEY,
    player_id VARCHAR(64) NOT NULL,
    event_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(32) NOT NULL,
    stage VARCHAR(16) NOT NULL,
    source VARCHAR(32) NOT NULL,
    amount INT NOT NULL,
    created_at BIGINT NOT NULL,
    KEY points_by_player_stage (player_id, stage),
    FOREIGN KEY (player_id) REFERENCES users(id),
    FOREIGN KEY (event_id, session_id) REFERENCES event_sessions(event_id, session_id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS points_accounts (
    player_id VARCHAR(64) PRIMARY KEY,
    balance BIGINT NOT NULL DEFAULT 0,
    version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    FOREIGN KEY (player_id) REFERENCES users(id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS points_session_accounts (
    event_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(32) NOT NULL,
    player_id VARCHAR(64) NOT NULL,
    balance BIGINT NOT NULL DEFAULT 0,
    version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, session_id, player_id),
    FOREIGN KEY (player_id) REFERENCES users(id),
    FOREIGN KEY (event_id, session_id) REFERENCES event_sessions(event_id, session_id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS progress (
    player_id VARCHAR(64) NOT NULL,
    stage VARCHAR(16) NOT NULL,
    meters INT NOT NULL,
    last_walk BIGINT NOT NULL,
    tracking TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, stage),
    FOREIGN KEY (player_id) REFERENCES users(id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS codes (
    hash CHAR(64) PRIMARY KEY,
    player_id VARCHAR(64) NOT NULL,
    stage VARCHAR(16) NOT NULL,
    mouse_id SMALLINT UNSIGNED NOT NULL,
    purpose VARCHAR(16) NOT NULL,
    expires_at BIGINT NOT NULL,
    used TINYINT NOT NULL DEFAULT 0,
    KEY codes_by_player (player_id, purpose),
    KEY codes_by_expiry (expires_at),
    FOREIGN KEY (player_id) REFERENCES users(id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS cooldowns (
    stage VARCHAR(16) NOT NULL,
    zone_id VARCHAR(64) NOT NULL,
    until BIGINT NOT NULL,
    PRIMARY KEY (stage, zone_id)
  ) ${tableOptions}`,
  // Claiming an action must not implicitly acquire a foreign-key lock on its player.
  `CREATE TABLE IF NOT EXISTS actions (
    player_id VARCHAR(64) NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    result LONGTEXT NOT NULL,
    PRIMARY KEY (player_id, request_id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    actor_user_id VARCHAR(64),
    action VARCHAR(64) NOT NULL,
    entity_type VARCHAR(64),
    entity_id VARCHAR(128),
    details JSON,
    created_at BIGINT NOT NULL,
    KEY audit_by_actor (actor_user_id, created_at),
    FOREIGN KEY (actor_user_id) REFERENCES users(id)
  ) ${tableOptions}`,
];

async function migrateAuth(connection) {
  const [applied] = await connection.query('SELECT version FROM schema_migrations WHERE version = 2');
  if (applied.length) return;

  // MySQL commits DDL separately. The column and both indexes are installed as one atomic ALTER.
  const [columns] = await connection.query(`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'openid'`);
  if (!columns.length) {
    await connection.query(`ALTER TABLE users ADD COLUMN openid VARCHAR(128),
      ADD UNIQUE KEY users_openid_unique (openid), ADD UNIQUE KEY users_student_id_unique (student_id)`);
  }
  await connection.query(`CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash CHAR(64) PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    KEY oauth_states_expiry (expires_at)
  ) ${tableOptions}`);
  await connection.query(`CREATE TABLE IF NOT EXISTS pending_registrations (
    id VARCHAR(64) PRIMARY KEY,
    openid VARCHAR(128) NOT NULL,
    expires_at BIGINT NOT NULL,
    KEY pending_registrations_expiry (expires_at)
  ) ${tableOptions}`);
  await connection.query(`CREATE TABLE IF NOT EXISTS event_registrations (
    user_id VARCHAR(64) NOT NULL,
    event_id VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, event_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  ) ${tableOptions}`);
  await connection.query('INSERT INTO schema_migrations (version) VALUES (2)');
}

export async function migrateMysql(connection) {
  const lockName = "CONCAT('campus_schema_', LEFT(SHA2(DATABASE(), 256), 40))";
  const [[lock]] = await connection.query(`SELECT GET_LOCK(${lockName}, 10) AS acquired`);
  if (lock.acquired !== 1) throw new Error('Could not acquire the MySQL migration lock');
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version SMALLINT UNSIGNED PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ${tableOptions}`);
    const [applied] = await connection.query('SELECT version FROM schema_migrations WHERE version = 1');
    if (!applied.length) await migrateInitial(connection);
    await migrateAuth(connection);
    await migrateParticipation(connection);
    await migrateMysqlAdmin(connection, tableOptions);
    await migrateMysqlAdminEventSettings(connection, tableOptions);
  } finally {
    await connection.query(`DO RELEASE_LOCK(${lockName})`);
  }
}

async function migrateInitial(connection) {
  for (const ddl of initialTables) await connection.query(ddl);
  const [indexes] = await connection.query(`SELECT INDEX_NAME AS name,
      GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_in_order
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'captures' AND NON_UNIQUE = 0
    GROUP BY INDEX_NAME`);
  const captureKeys = new Map(indexes.map((index) => [index.name, index.columns_in_order]));
  if (captureKeys.get('captures_by_mouse') !== 'event_id,session_id,player_id,mouse_player_id' ||
      captureKeys.get('captures_by_sample') !== 'event_id,player_id,stage,legacy_mouse_number') {
    throw new Error('MySQL captures uniqueness constraints do not match migration 1');
  }

  for (const verb of ['UPDATE', 'DELETE']) {
    const name = `points_ledger_no_${verb.toLowerCase()}`;
    const [existing] = await connection.execute(`SELECT 1 FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?`, [name]);
    if (!existing.length) {
      await connection.query(`CREATE TRIGGER ${name} BEFORE ${verb} ON points_ledger FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'points_ledger is append-only'`);
    }
  }
  await connection.query('INSERT INTO schema_migrations (version) VALUES (1)');
}

async function migrateParticipation(connection) {
  const [applied] = await connection.query('SELECT version FROM schema_migrations WHERE version = 3');
  if (applied.length) return;
  const [columns] = await connection.query(`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'gender'`);
  if (!columns.length) {
    await connection.query(`ALTER TABLE users ADD COLUMN gender VARCHAR(8) NOT NULL DEFAULT 'unknown'
      CHECK (gender IN ('unknown', 'male', 'female'))`);
  }
  for (const ddl of participationTables('users', tableOptions)) await connection.query(ddl);
  await connection.query('INSERT INTO schema_migrations (version) VALUES (3)');
}
