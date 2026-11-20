import { randomUUID } from 'node:crypto';
import campus from '../../src/data/campus.json' with { type: 'json' };
import { AuthError } from '../auth/error.mjs';
import { eventId } from '../db/migrations.mjs';
import { eventDate, eventWindow, sessionWindow } from '../rules.mjs';

export const firstEventDate = campus.startDate;
export const mouseLimit = 10;
export const mailType = 'top20_interview';
export const systemActor = Object.freeze({ kind: 'system', id: 'scheduler' });
export const eventStartDate = () => eventWindow().startDate;
export const eventEndDate = () => eventWindow().endDate;

export const startsAt = (day) => sessionWindow(day, 'morning').startsAt;
export const publishesAt = (day) => Date.parse(`${day}T20:40:00+08:00`);
export const shiftDay = (day, offset) => eventDate(startsAt(day) + offset * 86_400_000);

export function checkedDate(value) {
  const { startDate, endDate } = eventWindow();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value < startDate || value > endDate || !sessionWindow(value, 'morning')) {
    throw new AuthError('DATE', '请选择有效的活动日期。');
  }
  return value;
}

export async function lockAdmin(tx) {
  // The first morning task row serializes admin writes on both databases.
  const sessionId = `${eventWindow().startDate}:morning`;
  await tx.ensureSession(sessionId);
  await tx.lockSettlement(sessionId);
}

export function audit(tx, actor, day, action, now, userId, details) {
  return tx.run(`INSERT INTO admin_audit
    (id, event_id, event_date, actor_kind, actor_id, action, user_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  randomUUID(), eventId, day, actor.kind, actor.id, action, userId, JSON.stringify(details), now);
}
