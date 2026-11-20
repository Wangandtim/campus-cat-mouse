import { AuthError } from '../auth/error.mjs';
import { eventId } from '../db/migrations.mjs';
import { eventDate } from '../rules.mjs';
import { audit, checkedDate, eventEndDate, eventStartDate, lockAdmin, mouseLimit, shiftDay, startsAt, systemActor } from './common.mjs';
import { readSnapshot } from './top20.mjs';

const userIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const activatedAction = 'roster.activated';

function rosterDate(now) {
  const today = eventDate(now);
  return now >= startsAt(today) ? today : shiftDay(today, -1);
}

async function confirmedCandidates(query, users, day) {
  const sourceDay = shiftDay(day, -1);
  const snapshot = await readSnapshot(query, sourceDay);
  if (!snapshot?.entries.length) return [];
  const rows = await query.all(`SELECT u.id AS userId, u.name, u.student_id AS studentId
    FROM interview_records i JOIN ${users} u ON u.id = i.user_id
    WHERE i.event_id = ? AND i.event_date = ? AND i.status = 'CONFIRMED'`, eventId, sourceDay);
  const confirmed = new Map(rows.map((row) => [row.userId, row]));
  return snapshot.entries.filter((entry) => confirmed.has(entry.userId))
    .map(({ userId, rank }) => ({ ...confirmed.get(userId), rank }));
}

export async function readRoster(query, users, day) {
  const applied = await query.get(`SELECT created_at FROM admin_audit
    WHERE event_id = ? AND event_date = ? AND action = ?`, eventId, day, activatedAction);
  const rows = await query.all(`SELECT a.slot, a.user_id AS userId, a.assigned_by AS assignedBy,
    a.assigned_at AS assignedAt, u.name, u.student_id AS studentId
    FROM mouse_assignments a JOIN ${users} u ON u.id = a.user_id
    WHERE a.event_id = ? AND a.event_date = ? ORDER BY a.slot`, eventId, day);
  const candidates = day === eventStartDate() || applied ? [] : await confirmedCandidates(query, users, day);
  const assigned = new Set(rows.map(({ userId }) => userId));
  const occupied = new Set(rows.map(({ slot }) => slot));
  const reserve = candidates.filter(({ userId }) => !assigned.has(userId));
  for (let slot = 1; slot <= mouseLimit && reserve.length; slot++) {
    if (occupied.has(slot)) continue;
    const candidate = reserve.shift();
    rows.push({ ...candidate, slot, assignedBy: null, assignedAt: null });
  }
  rows.sort((a, b) => a.slot - b.slot);
  return { rows, reserve, activatedAt: applied?.created_at ?? null };
}

function insertAssignment(tx, day, slot, userId, actor, now) {
  return tx.run(`INSERT INTO mouse_assignments (event_id, event_date, slot, user_id, assigned_by, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?)`, eventId, day, slot, userId, actor.id, now);
}

async function saveProjectedSlots(tx, day, rows, now) {
  for (const row of rows) {
    if (row.assignedAt === null) await insertAssignment(tx, day, row.slot, row.userId, systemActor, now);
  }
}

export function createRosterService(store, clock, onRolesChanged) {
  const { users } = store.tables;
  let activatedDay;
  let activation;

  async function activate() {
    const day = rosterDate(clock());
    const first = eventStartDate();
    const last = eventEndDate();
    if (day < first || day > last || (activatedDay && activatedDay >= day)) return;
    if (activation) {
      await activation;
      return activate();
    }
    activation = store.transaction(async (tx) => {
      await lockAdmin(tx);
      const now = clock();
      const effectiveDay = rosterDate(now);
      if (effectiveDay < first || effectiveDay > last) return { effectiveDay, changed: [] };
      const roster = await readRoster(tx, users, effectiveDay);
      let changed = [];
      if (roster.activatedAt === null) {
        await saveProjectedSlots(tx, effectiveDay, roster.rows, now);
        const before = await tx.all(`SELECT id FROM ${users} WHERE role = 'mouse' AND openid IS NOT NULL`);
        const mice = new Set(roster.rows.map(({ userId }) => userId));
        const previous = new Set(before.map(({ id }) => id));
        const promoted = [...mice].filter((id) => !previous.has(id));
        const released = [...previous].filter((id) => !mice.has(id));
        changed = [...promoted, ...released];
        await tx.lockPlayers(changed);
        for (const id of promoted) await tx.run(`UPDATE ${users} SET role = 'mouse' WHERE id = ?`, id);
        for (const id of released) await tx.run(`UPDATE ${users} SET role = 'cat' WHERE id = ?`, id);
        await audit(tx, systemActor, effectiveDay, activatedAction, now, null, { userIds: [...mice] });
      }
      return { effectiveDay, changed };
    }).then(({ effectiveDay, changed }) => {
      activatedDay = effectiveDay;
      if (changed.length) onRolesChanged?.(changed);
    }).finally(() => { activation = undefined; });
    await activation;
    if (activatedDay !== rosterDate(clock())) await activate();
  }

  function assign(actor, body) {
    if (actor.kind !== 'teacher') throw new AuthError('TEACHER_AUTH', '只有教师可以任命鼠阵营。', 403);
    const day = checkedDate(body.eventDate);
    const { userId, replaceUserId } = body;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (typeof userId !== 'string' || !userIdPattern.test(userId) ||
        (replaceUserId !== undefined && (typeof replaceUserId !== 'string' || !userIdPattern.test(replaceUserId)))) {
      throw new AuthError('STUDENT', '请选择要任命或替换的学生。');
    }
    if (reason.length > 200 || /\p{C}/u.test(reason) || (replaceUserId !== undefined && !reason)) {
      throw new AuthError('ASSIGNMENT_REASON', '请填写 200 字以内的换人原因。');
    }
    return store.transaction(async (tx) => {
      await lockAdmin(tx);
      const now = clock();
      if (now >= startsAt(day)) throw new AuthError('ROSTER_LOCKED', '该日名单已到生效时间。', 409);
      const { rows, reserve } = await readRoster(tx, users, day);
      if (rows.some((row) => row.userId === userId)) throw new AuthError('DUPLICATE_MOUSE', '该学生已在当日名单。', 409);
      const replaced = rows.find((row) => row.userId === replaceUserId);
      if (replaceUserId !== undefined && !replaced) throw new AuthError('STALE_ROSTER', '名单已变化，请刷新后再操作。', 409);
      if (!replaced && rows.length >= mouseLimit) throw new AuthError('MOUSE_LIMIT', '当日鼠阵营名额已满。', 409);
      if (day === eventStartDate()) {
        const student = await tx.get(`SELECT u.id FROM ${users} u JOIN event_registrations r ON r.user_id = u.id
          WHERE r.event_id = ? AND u.id = ? AND u.openid IS NOT NULL`, eventId, userId);
        if (!student) throw new AuthError('STUDENT', '请选择已报名的学生。', 404);
      } else if (!reserve.some((row) => row.userId === userId)) {
        throw new AuthError('TOP20_REQUIRED', '请选择前一日榜单中已确认的候选。', 409);
      }

      await saveProjectedSlots(tx, day, rows.filter((row) => row !== replaced), now);
      const slot = replaced?.slot ?? rows.length + 1;
      if (replaced?.assignedAt != null) {
        await tx.run(`UPDATE mouse_assignments SET user_id = ?, assigned_by = ?, assigned_at = ?
          WHERE event_id = ? AND event_date = ? AND slot = ?`, userId, actor.id, now, eventId, day, slot);
      } else {
        await insertAssignment(tx, day, slot, userId, actor, now);
      }
      await audit(tx, actor, day, replaced ? 'roster.replaced' : 'roster.assigned', now, userId,
        { slot, replacedUserId: replaced?.userId ?? null, reason });
      return { slot };
    });
  }

  return { activate, assign };
}
