import { eventId } from '../db/migrations.mjs';
import { activeEvent, limits } from '../rules.mjs';
import { positionRetentionMs } from './retention.mjs';

export async function locationSharing(store, player, session, sampleTime = Infinity) {
  if (!player?.sharing || !session) return false;
  if (!player.registered) return true;
  const row = await store.read((tx) => tx.get(`SELECT p.status_at FROM participation_sessions p
    JOIN ${store.tables.users} u ON u.id = p.player_id
    WHERE p.event_id = ? AND p.session_id = ? AND p.player_id = ? AND p.status = 'active'
      AND u.sharing = 1 AND u.role = ? AND u.stage = ?`, eventId, session.id, player.id, player.role, player.stage));
  return !!row && sampleTime >= row.status_at;
}

export async function readLivePlayers(store, ids, now, lane) {
  if (!ids.length) return [];
  const morning = activeEvent('morning', now)?.id ?? '';
  const evening = activeEvent('evening', now)?.id ?? '';
  const rows = await store.read((tx) => tx.all(`SELECT u.id, u.role, u.stage, u.created_at, u.sharing,
      u.openid IS NOT NULL AS registered, p.status_at AS sharing_since
    FROM ${store.tables.users} u LEFT JOIN participation_sessions p
      ON p.player_id = u.id AND p.event_id = ? AND p.status = 'active'
      AND p.session_id = CASE u.stage WHEN 'morning' THEN ? WHEN 'evening' THEN ? ELSE '' END
    WHERE u.id IN (${ids.map(() => '?').join(', ')})`, eventId, morning, evening, ...ids),
  { lane, timeoutMs: 450 });
  return rows.map((row) => ({ ...row, sharing: !!row.sharing && (!row.registered || row.sharing_since != null) }));
}

export async function positionForResponse(store, player, position, clock) {
  if (!position) return null;
  const session = activeEvent(player.stage, clock());
  if (session && session.id === position.session_id && position.role === player.role &&
      position.updated_at >= session.startsAt && await locationSharing(store, player, session, position.updated_at)) {
    const now = clock();
    if (position.updated_at <= now && now - position.updated_at <= limits.positionAge && now < session.endsAt) {
      return position;
    }
  }
  return { role: position.role, session_id: position.session_id, updated_at: position.updated_at };
}

export function purgeLocationData(store, now, retentionMs = positionRetentionMs) {
  return store.transaction(async (tx) => {
    // Leave a margin beyond the capture freshness window and check age at deletion time.
    await tx.run('DELETE FROM positions WHERE updated_at < ?', now - retentionMs);
    await tx.run(`UPDATE participation_sessions SET anchor_lat = NULL, anchor_lng = NULL
      WHERE event_id = ? AND status IN ('settled', 'void') AND (anchor_lat IS NOT NULL OR anchor_lng IS NOT NULL)`, eventId);
  });
}
