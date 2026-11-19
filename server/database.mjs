import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename) {
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
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      player_id TEXT NOT NULL REFERENCES players(id),
      stage TEXT NOT NULL,
      meters INTEGER NOT NULL,
      last_walk INTEGER NOT NULL,
      tracking INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (player_id, stage)
    );
    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      stage TEXT NOT NULL,
      mouse_id INTEGER NOT NULL,
      zone_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      meters INTEGER NOT NULL,
      awarded INTEGER NOT NULL,
      UNIQUE (player_id, stage, mouse_id)
    );
    CREATE INDEX IF NOT EXISTS captures_by_zone ON captures(stage, zone_id, completed_at);
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
  return db;
}

export function openPositionStore(filename) {
  const db = openDatabase(filename);
  const read = db.prepare(`
    SELECT role, lat, lng, accuracy, updated_at FROM positions WHERE user_id = ?
  `);
  const write = db.prepare(`
    INSERT INTO positions (user_id, role, lat, lng, accuracy, updated_at)
    SELECT id, role, ?, ?, ?, ? FROM players WHERE id = ?
    ON CONFLICT(user_id) DO UPDATE SET
      role = excluded.role,
      lat = excluded.lat,
      lng = excluded.lng,
      accuracy = excluded.accuracy,
      updated_at = excluded.updated_at
    RETURNING role, lat, lng, accuracy, updated_at
  `);
  return {
    get: (userId) => read.get(userId) ?? null,
    save: (userId, { lat, lng, accuracy }) => write.get(lat, lng, accuracy, Date.now(), userId),
    close: () => db.close(),
  };
}
