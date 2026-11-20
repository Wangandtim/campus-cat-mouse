import { randomUUID } from 'node:crypto';
import { eventId } from '../db/migrations.mjs';
import { shiftDay, startsAt } from './common.mjs';
import { readSnapshot } from './top20.mjs';

const rowKey = 'event_id = ? AND event_date = ? AND user_id = ? AND type = ?';
const retryDelay = (attempts) => Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts, 5));

export function createMailTransport(env) {
  if (['demo', 'mock'].includes(env.CAMPUS_AUTH_MODE?.trim()) || env.NODE_ENV === 'test') return null;
  const key = env.CAMPUS_RESEND_API_KEY?.trim();
  const from = env.CAMPUS_MAIL_FROM?.trim();
  if (!key && !from) return null;
  if (!key || !from) throw new Error('发信需同时配置 CAMPUS_RESEND_API_KEY 和 CAMPUS_MAIL_FROM。');
  const activityUrl = env.CAMPUS_PUBLIC_ORIGIN?.trim();
  return async ({ recipient, day, rank, idempotencyKey }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from, to: [recipient], subject: '猫鼠追缉令面谈邀约',
        text: `你在 ${day} 的有效成绩排名第 ${rank}。请按时面谈。不能参加请在活动 H5 放弃本人邀约。\n${activityUrl ?? ''}`,
      }),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw Object.assign(new Error('邮件服务拒绝请求。'), { mailCode: `HTTP_${response.status}` });
  };
}

export async function deliverOutbox(store, send, clock = Date.now) {
  if (!send) return;
  const now = clock();
  const rows = await store.read((tx) => tx.all(`SELECT event_date, user_id, type, recipient, attempts FROM email_outbox
    WHERE event_id = ? AND status IN ('pending', 'failed') AND next_attempt_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?)
    ORDER BY next_attempt_at, event_date, user_id LIMIT 20`, eventId, now, now));
  for (const row of rows) {
    const day = row.event_date;
    const key = [eventId, day, row.user_id, row.type];
    const claimedAt = clock();
    const lease = randomUUID();
    const deadline = startsAt(shiftDay(day, 1));
    const eligible = `${rowKey} AND status IN ('pending', 'failed') AND next_attempt_at <= ?
      AND attempts = ? AND (lease_until IS NULL OR lease_until <= ?)`;
    if (claimedAt >= deadline) {
      await store.transaction((tx) => tx.run(`UPDATE email_outbox SET status = 'failed',
        next_attempt_at = NULL, lease_id = NULL, lease_until = NULL, last_error = 'INVITATION_EXPIRED' WHERE ${eligible}`,
      ...key, claimedAt, row.attempts, claimedAt));
      continue;
    }
    const claimed = await store.transaction((tx) => tx.run(`UPDATE email_outbox SET
      attempts = attempts + 1, lease_id = ?, lease_until = ? WHERE ${eligible}`,
    lease, claimedAt + 60_000, ...key, claimedAt, row.attempts, claimedAt));
    if ((claimed.affectedRows ?? claimed.changes) !== 1) continue;

    let errorCode = null;
    try {
      const snapshot = await store.read((tx) => readSnapshot(tx, day));
      const entry = snapshot?.entries.find(({ userId }) => userId === row.user_id);
      if (!entry) throw Object.assign(new Error(), { mailCode: 'MISSING_SNAPSHOT_ENTRY' });
      await send({ recipient: row.recipient, day, rank: entry.rank, idempotencyKey: key.join('/') });
    } catch (error) {
      errorCode = error.mailCode ?? 'DELIVERY_ERROR';
    }

    const finishedAt = clock();
    const retryAt = finishedAt + retryDelay(row.attempts);
    await store.transaction((tx) => tx.run(`UPDATE email_outbox SET status = ?, next_attempt_at = ?,
      lease_id = NULL, lease_until = NULL, last_error = ?, sent_at = ? WHERE ${rowKey} AND lease_id = ?`,
    errorCode ? 'failed' : 'sent', errorCode && retryAt < deadline ? retryAt : null,
    errorCode, errorCode ? null : finishedAt, ...key, lease));
  }
}
