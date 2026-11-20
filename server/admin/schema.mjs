const snapshotTable = 'top20_snapshots';
const mutationVerbs = ['UPDATE', 'DELETE'];

function adminTables(users, options = '') {
  return [
    `CREATE TABLE IF NOT EXISTS ${snapshotTable} (
      event_id VARCHAR(64) NOT NULL,
      event_date VARCHAR(10) NOT NULL,
      entries JSON NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (event_id, event_date)
    ) ${options}`,
    `CREATE TABLE IF NOT EXISTS mouse_assignments (
      event_id VARCHAR(64) NOT NULL,
      event_date VARCHAR(10) NOT NULL,
      slot INT NOT NULL CHECK (slot BETWEEN 1 AND 10),
      user_id VARCHAR(64) NOT NULL,
      assigned_by VARCHAR(64) NOT NULL,
      assigned_at BIGINT NOT NULL,
      PRIMARY KEY (event_id, event_date, slot),
      UNIQUE (event_id, event_date, user_id),
      FOREIGN KEY (user_id) REFERENCES ${users}(id)
    ) ${options}`,
    `CREATE TABLE IF NOT EXISTS interview_records (
      event_id VARCHAR(64) NOT NULL,
      event_date VARCHAR(10) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      status VARCHAR(12) NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'DECLINED', 'WAITLISTED', 'NO_SHOW')),
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (event_id, event_date, user_id),
      FOREIGN KEY (event_id, event_date) REFERENCES ${snapshotTable}(event_id, event_date),
      FOREIGN KEY (user_id) REFERENCES ${users}(id)
    ) ${options}`,
    `CREATE TABLE IF NOT EXISTS email_outbox (
      event_id VARCHAR(64) NOT NULL,
      event_date VARCHAR(10) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      type VARCHAR(32) NOT NULL,
      recipient VARCHAR(254),
      status VARCHAR(8) NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at BIGINT,
      lease_id VARCHAR(36),
      lease_until BIGINT,
      last_error VARCHAR(48),
      sent_at BIGINT,
      PRIMARY KEY (event_id, event_date, user_id, type),
      FOREIGN KEY (event_id, event_date, user_id) REFERENCES interview_records(event_id, event_date, user_id)
    ) ${options}`,
    `CREATE TABLE IF NOT EXISTS admin_audit (
      id VARCHAR(36) PRIMARY KEY,
      event_id VARCHAR(64) NOT NULL,
      event_date VARCHAR(10) NOT NULL,
      actor_kind VARCHAR(8) NOT NULL,
      actor_id VARCHAR(64) NOT NULL,
      action VARCHAR(32) NOT NULL,
      user_id VARCHAR(64),
      details JSON NOT NULL,
      created_at BIGINT NOT NULL
    ) ${options}`,
    `CREATE TABLE IF NOT EXISTS event_settings (
      event_id VARCHAR(64) PRIMARY KEY,
      starts_on VARCHAR(10) NOT NULL,
      ends_on VARCHAR(10) NOT NULL,
      updated_at BIGINT NOT NULL
    ) ${options}`,
  ];
}

const triggerName = (verb) => `${snapshotTable}_no_${verb.toLowerCase()}`;
const message = 'top20_snapshots is immutable';

export function migrateSqliteAdmin(db) {
  for (const ddl of adminTables('players')) db.exec(ddl);
  db.exec(`CREATE INDEX IF NOT EXISTS admin_audit_by_day ON admin_audit (event_id, event_date, action);
    CREATE INDEX IF NOT EXISTS interviews_by_user ON interview_records (event_id, user_id, event_date);
    CREATE INDEX IF NOT EXISTS outbox_by_due ON email_outbox (event_id, next_attempt_at)`);
  for (const verb of mutationVerbs) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${triggerName(verb)} BEFORE ${verb} ON ${snapshotTable}
      BEGIN SELECT RAISE(ABORT, '${message}'); END`);
  }
  // SQLite REPLACE can skip DELETE triggers on connections without recursive triggers.
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${triggerName('REPLACE')} BEFORE INSERT ON ${snapshotTable}
    WHEN EXISTS (SELECT 1 FROM ${snapshotTable} WHERE event_id = NEW.event_id AND event_date = NEW.event_date)
    BEGIN SELECT RAISE(ABORT, '${message}'); END`);
}

export async function migrateMysqlAdminEventSettings(connection, options) {
  const [applied] = await connection.query('SELECT version FROM schema_migrations WHERE version = 5');
  if (applied.length) return;
  await connection.query(`CREATE TABLE IF NOT EXISTS event_settings (
    event_id VARCHAR(64) PRIMARY KEY,
    starts_on VARCHAR(10) NOT NULL,
    ends_on VARCHAR(10) NOT NULL,
    updated_at BIGINT NOT NULL
  ) ${options}`);
  await connection.query('INSERT INTO schema_migrations (version) VALUES (5)');
}

export async function migrateMysqlAdmin(connection, options) {
  const [applied] = await connection.query('SELECT version FROM schema_migrations WHERE version = 4');
  if (applied.length) return;
  for (const ddl of adminTables('users', options)) await connection.query(ddl);
  for (const [table, name, columns] of [
    ['admin_audit', 'admin_audit_by_day', 'event_id, event_date, action'],
    ['interview_records', 'interviews_by_user', 'event_id, user_id, event_date'],
    ['email_outbox', 'outbox_by_due', 'event_id, next_attempt_at'],
  ]) {
    const [index] = await connection.execute(`SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name]);
    if (!index.length) await connection.query(`CREATE INDEX ${name} ON ${table} (${columns})`);
  }
  for (const verb of mutationVerbs) {
    const name = triggerName(verb);
    const [existing] = await connection.execute(`SELECT 1 FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?`, [name]);
    if (!existing.length) {
      await connection.query(`CREATE TRIGGER ${name} BEFORE ${verb} ON ${snapshotTable} FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`);
    }
  }
  await connection.query('INSERT INTO schema_migrations (version) VALUES (4)');
}
