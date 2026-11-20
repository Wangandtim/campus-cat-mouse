export function eventSessionsTable(options = '') {
  return `CREATE TABLE IF NOT EXISTS event_sessions (
    event_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(32) NOT NULL,
    event_date DATE NOT NULL,
    stage VARCHAR(16) NOT NULL,
    starts_at BIGINT NOT NULL,
    ends_at BIGINT NOT NULL,
    PRIMARY KEY (event_id, session_id)
  ) ${options}`;
}

export function participationTables(users, options = '') {
  return [
    `CREATE TABLE IF NOT EXISTS session_settlements (
      event_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(32) NOT NULL,
      settled_at BIGINT,
      PRIMARY KEY (event_id, session_id),
      FOREIGN KEY (event_id, session_id) REFERENCES event_sessions(event_id, session_id)
    ) ${options}`,
    `CREATE TABLE IF NOT EXISTS participation_sessions (
      event_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(32) NOT NULL,
      player_id VARCHAR(64) NOT NULL,
      role VARCHAR(8) NOT NULL,
      gender VARCHAR(8) NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT,
      status VARCHAR(12) NOT NULL,
      status_at BIGINT NOT NULL,
      paused_total_seconds DOUBLE NOT NULL DEFAULT 0,
      valid_meters DOUBLE NOT NULL DEFAULT 0,
      required_meters INT,
      max_seconds INT,
      completed_at BIGINT,
      last_sample_at BIGINT,
      last_movement_at BIGINT,
      last_capture_meters DOUBLE,
      anchor_lat DOUBLE,
      anchor_lng DOUBLE,
      gap_started_at BIGINT,
      gap_reason VARCHAR(16),
      data_gap_seconds DOUBLE NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, session_id, player_id),
      FOREIGN KEY (event_id, session_id) REFERENCES event_sessions(event_id, session_id),
      FOREIGN KEY (player_id) REFERENCES ${users}(id)
    ) ${options}`,
  ];
}
