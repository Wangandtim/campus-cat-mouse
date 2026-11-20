import { eventId } from '../db/migrations.mjs';
import { eventDate } from '../rules.mjs';
import { audit, eventEndDate, eventStartDate, lockAdmin, mailType, publishesAt, shiftDay, systemActor } from './common.mjs';

export async function readSnapshot(query, day) {
  const row = await query.get('SELECT entries, created_at FROM top20_snapshots WHERE event_id = ? AND event_date = ?', eventId, day);
  if (!row) return null;
  return {
    createdAt: row.created_at,
    entries: typeof row.entries === 'string' ? JSON.parse(row.entries) : row.entries,
  };
}

export function latestDueDate(now) {
  const today = eventDate(now);
  return now >= publishesAt(today) ? today : shiftDay(today, -1);
}

export async function prepareSettlementDays(store, now) {
  const today = eventDate(now);
  const first = eventStartDate();
  const last = eventEndDate();
  if (today < first || today > last) return;
  await store.transaction(async (tx) => {
    const incompleteDays = await tx.all(`SELECT event_date FROM event_sessions
      WHERE event_id = ? AND event_date BETWEEN ? AND ? GROUP BY event_date HAVING COUNT(*) < 2`,
    eventId, first, today);
    const days = new Set([today, shiftDay(today, -1), ...incompleteDays.map((row) => row.event_date)]);
    for (const day of [...days].sort()) {
      if (day < first || day > last) continue;
      await tx.ensureSession(`${day}:morning`);
      await tx.ensureSession(`${day}:evening`);
    }
  });
}

async function rankDay(tx, users, morning, evening) {
  const captureEvent = users === 'users' ? 'AND c.event_id = p.event_id' : '';
  const rows = await tx.all(`WITH captured_sessions AS (
      SELECT p.player_id, p.session_id, p.valid_meters, p.data_gap_seconds,
        COUNT(c.id) AS capture_count, MAX(c.completed_at) AS last_capture_at
      FROM participation_sessions p
      JOIN captures c ON c.player_id = p.player_id AND c.session_id = p.session_id ${captureEvent}
      JOIN event_registrations r ON r.event_id = p.event_id AND r.user_id = p.player_id
      WHERE p.event_id = ? AND p.session_id IN (?, ?) AND c.mouse_player_id IS NOT NULL
        AND p.role = 'cat' AND p.status = 'settled' AND p.valid_meters >= p.required_meters
        AND p.completed_at - p.started_at <= p.max_seconds * 1000
      GROUP BY p.player_id, p.session_id, p.valid_meters, p.data_gap_seconds
    )
    SELECT player_id, SUM(capture_count) AS captures, SUM(valid_meters) AS meters,
      MAX(last_capture_at) AS achieved_at, MAX(CASE WHEN data_gap_seconds > 0 THEN 1 ELSE 0 END) AS data_gap
    FROM captured_sessions GROUP BY player_id
    ORDER BY captures DESC, meters DESC, achieved_at ASC, player_id ASC LIMIT 20`, eventId, morning, evening);
  return rows.map((row, index) => ({
    rank: index + 1,
    userId: row.player_id,
    captures: Number(row.captures),
    validMeters: Number(row.meters),
    achievedAt: Number(row.achieved_at),
    dataGap: Boolean(row.data_gap),
  }));
}

export function publishTop20(store, day, now) {
  if (day < eventStartDate() || day > eventEndDate() || now < publishesAt(day)) return 'early';
  return store.transaction(async (tx) => {
    await lockAdmin(tx);
    if (await readSnapshot(tx, day)) return 'existing';
    const morning = `${day}:morning`;
    const evening = `${day}:evening`;
    const settled = await tx.all(`SELECT session_id FROM session_settlements
      WHERE event_id = ? AND session_id IN (?, ?) AND settled_at IS NOT NULL`, eventId, morning, evening);
    if (settled.length !== 2) return 'waiting';

    const { users } = store.tables;
    const entries = await rankDay(tx, users, morning, evening);
    await tx.run('INSERT INTO top20_snapshots (event_id, event_date, entries, created_at) VALUES (?, ?, ?, ?)',
      eventId, day, JSON.stringify(entries), now);
    await audit(tx, systemActor, day, 'snapshot.created', now, null, { count: entries.length });
    for (const { userId } of entries) {
      const { email } = await tx.get(`SELECT email FROM ${users} WHERE id = ?`, userId);
      const recipient = email?.trim() || null;
      await tx.run(`INSERT INTO interview_records (event_id, event_date, user_id, status, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?)`, eventId, day, userId, now);
      await tx.run(`INSERT INTO email_outbox (event_id, event_date, user_id, type, recipient, status, next_attempt_at, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, eventId, day, userId, mailType, recipient,
      recipient ? 'pending' : 'failed', recipient ? now : null, recipient ? null : 'MISSING_EMAIL');
      await audit(tx, systemActor, day, 'interview.created', now, userId, { to: 'PENDING' });
    }
    return 'published';
  });
}

export async function publishDueTop20(store, now, onWaiting) {
  const last = eventEndDate();
  const due = latestDueDate(now);
  if (due < eventStartDate()) return;
  const days = await store.read((tx) => tx.all(`SELECT DISTINCT e.event_date FROM event_sessions e
    LEFT JOIN top20_snapshots s ON s.event_id = e.event_id AND s.event_date = e.event_date
    WHERE e.event_id = ? AND e.event_date BETWEEN ? AND ? AND s.event_id IS NULL ORDER BY e.event_date`,
  eventId, eventStartDate(), due > last ? last : due));
  for (const { event_date: day } of days) {
    if (await publishTop20(store, day, now) === 'waiting') onWaiting(day);
  }
}
