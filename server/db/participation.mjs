import { randomUUID } from 'node:crypto';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { distance } from '@turf/distance';
import { campusFence, cappedAward, catRequirement, limits, mileagePoints, validPosition } from '../rules.mjs';
import { eventId } from './migrations.mjs';

export function participationOf(tx, sessionId, playerId) {
  return tx.get('SELECT * FROM participation_sessions WHERE event_id = ? AND session_id = ? AND player_id = ?',
    eventId, sessionId, playerId);
}

function key(row) {
  return [row.event_id, row.session_id, row.player_id];
}

function audit(tx, row, action, details, now) {
  return tx.run(`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, details, created_at)
    VALUES (NULL, ?, 'participation_session', ?, ?, ?)`,
  action, `${row.session_id}/${row.player_id}`, JSON.stringify(details), now);
}

export function createParticipation(tx, sessionId, player, now) {
  const requirement = player.role === 'cat' ? catRequirement(player.stage, player.gender) : null;
  return tx.run(`INSERT INTO participation_sessions
    (event_id, session_id, player_id, role, gender, started_at, status, status_at, required_meters, max_seconds)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  eventId, sessionId, player.id, player.role, player.gender, now, now,
  requirement?.meters ?? null, requirement?.seconds ?? null);
}

function gapStart(row) {
  return row.last_sample_at ?? row.status_at;
}

export async function markDataGap(tx, row, reason) {
  if (row?.status !== 'active' || row.gap_started_at !== null) return;
  await tx.run(`UPDATE participation_sessions SET gap_started_at = ?, gap_reason = ?, anchor_lat = NULL, anchor_lng = NULL
    WHERE event_id = ? AND session_id = ? AND player_id = ?`, gapStart(row), reason, ...key(row));
}

async function closeDataGap(tx, row, now) {
  const start = row.gap_started_at ?? gapStart(row);
  if (row.gap_started_at === null && now - start <= limits.mileageGap) return 0;
  if (now <= start) return 0;
  await audit(tx, row, 'data_gap', {
    reason: row.gap_reason ?? 'timeout', startedAt: start, endedAt: now, reviewable: true,
  }, now);
  return (now - start) / 1000;
}

export async function changeParticipation(tx, row, status, now) {
  if (!row || row.status === status || ['settled', 'void'].includes(row.status)) return;
  const gap = row.status === 'active' ? await closeDataGap(tx, row, now) : 0;
  const pause = row.status === 'active' ? 0 : (now - row.status_at) / 1000;
  await tx.run(`UPDATE participation_sessions SET status = ?, status_at = ?, ended_at = ?,
      paused_total_seconds = paused_total_seconds + ?, data_gap_seconds = data_gap_seconds + ?,
      anchor_lat = NULL, anchor_lng = NULL, last_sample_at = NULL, gap_started_at = NULL, gap_reason = NULL
    WHERE event_id = ? AND session_id = ? AND player_id = ?`,
  status, now, status === 'exited' ? now : null, pause, gap, ...key(row));
}

export async function recordMileage(tx, row, point, now, reportedGap) {
  if (row?.status !== 'active' || now < row.status_at || now <= (row.last_sample_at ?? -1)) return false;
  const coordinates = [point.lng, point.lat];
  if (!validPosition(point) || point.accuracy > limits.mileageAccuracy || !booleanPointInPolygon(coordinates, campusFence)) {
    await markDataGap(tx, row, reportedGap ?? 'gps');
    return true;
  }
  if (reportedGap && row.gap_started_at === null) {
    row = { ...row, gap_started_at: gapStart(row), gap_reason: reportedGap };
  }
  const gap = await closeDataGap(tx, row, now);
  let meters = 0;
  if (gap === 0 && row.gap_started_at === null && row.anchor_lat !== null) {
    meters = distance([row.anchor_lng, row.anchor_lat], coordinates, { units: 'meters' });
    if (meters > (now - row.last_sample_at) * limits.mileageSpeed / 1000) {
      await markDataGap(tx, row, 'jump');
      return true;
    }
  }
  const total = row.valid_meters + meters;
  const completed = row.completed_at ?? (row.required_meters !== null && total >= row.required_meters ? now : null);
  await tx.run(`UPDATE participation_sessions SET valid_meters = ?, completed_at = ?, last_sample_at = ?,
      last_movement_at = ?, anchor_lat = ?, anchor_lng = ?, data_gap_seconds = data_gap_seconds + ?,
      gap_started_at = NULL, gap_reason = NULL
    WHERE event_id = ? AND session_id = ? AND player_id = ?`,
  total, completed, now, meters > 0 ? now : row.last_movement_at, point.lat, point.lng, gap, ...key(row));
  return true;
}

export function earnedPoints(tx, ledger, playerId, sessionId) {
  const day = sessionId.slice(0, 10);
  return tx.get(`SELECT
      COALESCE(SUM(CASE WHEN session_id = ? THEN amount ELSE 0 END), 0) AS session,
      COALESCE(SUM(amount), 0) AS daily
    FROM ${ledger}
    WHERE player_id = ? AND session_id IN (?, ?) AND (amount > 0 OR source = 'capture_reversal')`,
  sessionId, playerId, `${day}:morning`, `${day}:evening`);
}

async function settlePlayer(tx, ledger, row, session, now) {
  const pause = row.paused_total_seconds + (row.status === 'active' ? 0 : (session.ends_at - row.status_at) / 1000);
  const gap = row.data_gap_seconds + (row.status === 'active' ? await closeDataGap(tx, row, session.ends_at) : 0);
  const absentMs = row.started_at - session.starts_at + Math.round(pause * 1000);
  const fullAttendance = row.role === 'mouse' && absentMs < limits.mousePauseSeconds * 1000;
  const catPassed = row.role !== 'cat' || (row.completed_at !== null &&
    row.completed_at - row.started_at <= row.max_seconds * 1000);
  const post = (source, amount) => amount && tx.addPoints(randomUUID(), row.player_id, session.stage, source, amount, now, row.session_id);
  let reversal = 0;
  let base = 0;
  let mileage = 0;
  if (!catPassed) {
    const { points } = await tx.get(`SELECT COALESCE(SUM(amount), 0) AS points FROM ${ledger}
      WHERE player_id = ? AND session_id = ? AND source = 'capture' AND amount > 0`, row.player_id, row.session_id);
    reversal = points;
    await post('capture_reversal', -points);
  } else {
    const earned = await earnedPoints(tx, ledger, row.player_id, row.session_id);
    base = cappedAward(fullAttendance ? 100 : 0, earned.session, earned.daily);
    mileage = cappedAward(mileagePoints(row.role, row.valid_meters), earned.session + base, earned.daily + base);
    await post('mouse_attendance', base);
    await post('mileage', mileage);
  }
  await tx.run(`UPDATE participation_sessions SET status = ?, status_at = ?, ended_at = COALESCE(ended_at, ?),
      paused_total_seconds = ?, data_gap_seconds = ?, anchor_lat = NULL, anchor_lng = NULL,
      gap_started_at = NULL, gap_reason = NULL
    WHERE event_id = ? AND session_id = ? AND player_id = ?`,
  catPassed ? 'settled' : 'void', session.ends_at, session.ends_at, pause, gap, ...key(row));
  await audit(tx, row, catPassed ? 'session_settled' : 'session_void', {
    role: row.role, validMeters: row.valid_meters, eligibleMeters: catPassed ? row.valid_meters : 0,
    pausedSeconds: pause, dataGapSeconds: gap, attendanceAbsenceSeconds: absentMs / 1000,
    uncoveredSeconds: (absentMs + Math.round(gap * 1000)) / 1000,
    fullAttendance, base, mileage, captureReversal: reversal,
  }, now);
}

export async function settleDueSessions(store, now) {
  const due = await store.read((db) => db.all(`SELECT e.* FROM event_sessions e
    LEFT JOIN session_settlements s ON s.event_id = e.event_id AND s.session_id = e.session_id
    WHERE e.event_id = ? AND e.ends_at <= ? AND s.settled_at IS NULL ORDER BY e.ends_at`, eventId, now));
  let settled = 0;
  for (const session of due) {
    settled += await store.transaction(async (tx) => {
      // Starts acquire the same task row before the player row. No new participant can slip
      // between this transaction's scan and its settlement marker.
      if ((await tx.lockSettlement(session.session_id)).settled_at !== null) return 0;
      const ids = await tx.all(`SELECT player_id FROM participation_sessions
        WHERE event_id = ? AND session_id = ? ORDER BY player_id`, eventId, session.session_id);
      await tx.lockPlayers(ids.map(({ player_id }) => player_id));
      const rows = await tx.all(`SELECT * FROM participation_sessions WHERE event_id = ? AND session_id = ?
        ORDER BY player_id`, eventId, session.session_id);
      for (const row of rows) await settlePlayer(tx, store.tables.ledger, row, session, now);
      await tx.run('UPDATE session_settlements SET settled_at = ? WHERE event_id = ? AND session_id = ?',
        now, eventId, session.session_id);
      return 1;
    });
  }
  return settled;
}
