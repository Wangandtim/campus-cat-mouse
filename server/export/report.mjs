import { eventId } from '../db/migrations.mjs';
import { rankPlayers, eventWindow } from '../rules.mjs';

export async function readClassReport(store, day, scope = 'day') {
  const { users, ledger } = store.tables;
  const total = scope === 'total';
  const enrollmentCutoff = Date.parse(`${day}T00:00:00+08:00`) + 86_400_000;
  const range = eventWindow();
  const participationWhere = total
    ? 'WHERE event_id = ? AND substr(session_id, 1, 10) BETWEEN ? AND ?'
    : 'WHERE event_id = ? AND session_id IN (?, ?)';
  const participationParams = total
    ? [eventId, range.startDate, range.endDate]
    : [eventId, `${day}:morning`, `${day}:evening`];
  // The SQLite preview has a single event and its legacy capture/ledger tables have no event_id.
  const captureEvent = users === 'users' ? 'AND c.event_id = p.event_id' : '';
  const ledgerEvent = users === 'users' ? 'AND l.event_id = p.event_id' : '';
  const rows = await store.read((tx) => tx.all(`
    WITH participation_scope AS (
      SELECT event_id, session_id, player_id, status, valid_meters, data_gap_seconds, gap_started_at
      FROM participation_sessions ${participationWhere}
    ), participation_summary AS (
      SELECT player_id, COUNT(*) AS sessions,
        SUM(CASE WHEN status <> 'void' THEN valid_meters ELSE 0 END) AS meters,
        MAX(CASE WHEN data_gap_seconds > 0 OR gap_started_at IS NOT NULL THEN 1 ELSE 0 END) AS dataGap,
        MAX(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS voided,
        MAX(CASE WHEN status NOT IN ('settled', 'void') THEN 1 ELSE 0 END) AS unsettled
      FROM participation_scope GROUP BY player_id
    ), capture_summary AS (
      SELECT c.player_id, COUNT(*) AS captures, MAX(c.completed_at) AS achievedAt
      FROM captures c JOIN participation_scope p ON c.player_id = p.player_id AND c.session_id = p.session_id ${captureEvent}
      WHERE p.status <> 'void' AND c.mouse_player_id IS NOT NULL
      GROUP BY c.player_id
    ), points_summary AS (
      SELECT l.player_id, SUM(l.amount) AS points
      FROM ${ledger} l JOIN participation_scope p ON l.player_id = p.player_id AND l.session_id = p.session_id ${ledgerEvent}
      WHERE l.amount > 0 OR l.source = 'capture_reversal'
      GROUP BY l.player_id
    )
    SELECT u.id, u.name, u.student_id AS studentId, u.grade, u.college, u.class_name AS className, u.phone, u.email,
      COALESCE(p.sessions, 0) AS sessions, COALESCE(p.meters, 0) AS meters,
      COALESCE(c.captures, 0) AS captures, c.achievedAt, COALESCE(l.points, 0) AS points,
      p.dataGap, p.voided, p.unsettled
    FROM event_registrations r JOIN ${users} u ON r.user_id = u.id
    LEFT JOIN participation_summary p ON p.player_id = u.id
    LEFT JOIN capture_summary c ON c.player_id = u.id
    LEFT JOIN points_summary l ON l.player_id = u.id
    WHERE r.event_id = ? ${total ? '' : 'AND r.created_at < ?'} AND u.openid IS NOT NULL
    ORDER BY u.student_id, u.id
  `, ...participationParams, eventId, ...(total ? [] : [enrollmentCutoff])));

  const participants = [];
  const absent = [];
  for (const { dataGap, voided, unsettled, ...row } of rows) {
    const flags = [];
    if (Number(dataGap)) flags.push('data_gap');
    if (Number(voided)) flags.push('成绩作废');
    if (Number(unsettled)) flags.push('未结算');
    const student = {
      ...row,
      studentId: String(row.studentId ?? ''),
      phone: String(row.phone ?? ''),
      email: String(row.email ?? ''),
      captures: Number(row.captures),
      meters: Number(row.meters),
      points: Number(row.points),
      sessions: Number(row.sessions),
      flags: flags.join('、'),
    };
    if (student.sessions) participants.push(student);
    else absent.push({ ...student, rank: 0 });
  }
  return [...rankPlayers(participants), ...absent];
}
