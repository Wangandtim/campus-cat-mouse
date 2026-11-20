import campus from '../../src/data/campus.json' with { type: 'json' };
import { AuthError } from '../auth/error.mjs';
import { eventId } from '../db/migrations.mjs';
import { configureEventWindow, eventWindow } from '../rules.mjs';
import { audit, lockAdmin, startsAt } from './common.mjs';

const dayValue = /^\d{4}-\d{2}-\d{2}$/;
const shanghaiDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const defaultEnd = (() => {
  const start = Date.parse(`${campus.startDate}T00:00:00+08:00`);
  return shanghaiDate.format(start + 30 * 86_400_000);
})();

function validDay(value) {
  if (typeof value !== 'string' || !dayValue.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00+08:00`);
  return Number.isFinite(parsed) && shanghaiDate.format(parsed) === value;
}

function daysBetween(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00+08:00`) - Date.parse(`${startDate}T00:00:00+08:00`)) / 86_400_000) + 1;
}

export function defaultEventSettings() {
  return { startDate: campus.startDate, endDate: defaultEnd };
}

export async function readEventSettings(store, apply = false) {
  const row = await store.read((tx) => tx.get(
    'SELECT starts_on AS startDate, ends_on AS endDate FROM event_settings WHERE event_id = ?', eventId));
  const settings = row && validDay(row.startDate) && validDay(row.endDate) && row.endDate >= row.startDate
    ? { startDate: row.startDate, endDate: row.endDate }
    : defaultEventSettings();
  if (apply) configureEventWindow(settings.startDate, settings.endDate);
  return {
    ...settings,
    durationDays: daysBetween(settings.startDate, settings.endDate),
    currentWindow: eventWindow(),
  };
}

export async function saveEventSettings(store, actor, body, now) {
  const startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const durationDays = Number(body.durationDays);
  if (!validDay(startDate)) throw new AuthError('EVENT_DATE', '请选择活动开始日期。', 422);
  if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
    throw new AuthError('EVENT_DURATION', '活动持续天数必须是 1–3650 天的整数。', 422);
  }
  const endDate = shanghaiDate.format(Date.parse(`${startDate}T00:00:00+08:00`) + (durationDays - 1) * 86_400_000);
  const current = await readEventSettings(store);
  if (now >= startsAt(current.startDate) &&
      (startDate !== current.startDate || endDate < current.endDate)) {
    throw new AuthError('EVENT_LOCKED', '活动已开始，只能延长结束日期，不能修改开始日期或缩短活动。', 409);
  }

  const mysql = store.tables.users === 'users';
  await store.transaction(async (tx) => {
    await lockAdmin(tx);
    if (mysql) {
      await tx.run(`INSERT INTO event_settings (event_id, starts_on, ends_on, updated_at)
        VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE starts_on = VALUES(starts_on),
        ends_on = VALUES(ends_on), updated_at = VALUES(updated_at)`, eventId, startDate, endDate, now);
    } else {
      await tx.run(`INSERT INTO event_settings (event_id, starts_on, ends_on, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET
        starts_on = excluded.starts_on, ends_on = excluded.ends_on, updated_at = excluded.updated_at`,
      eventId, startDate, endDate, now);
    }
    if (actor) await audit(tx, actor, startDate, 'event.settings', now, null, {
      startDate, endDate, durationDays,
    });
  });
  configureEventWindow(startDate, endDate);
  return { startDate, endDate, durationDays };
}
