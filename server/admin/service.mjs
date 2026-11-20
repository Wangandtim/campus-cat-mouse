import { AuthError } from '../auth/error.mjs';
import { eventId } from '../db/migrations.mjs';
import { eventDate } from '../rules.mjs';
import { audit, checkedDate, eventEndDate, eventStartDate, lockAdmin, mailType, publishesAt, shiftDay, startsAt } from './common.mjs';
import { readEventSettings, saveEventSettings as persistEventSettings } from './event-settings.mjs';
import { deliverOutbox } from './outbox.mjs';
import { createRosterService, readRoster } from './roster.mjs';
import { latestDueDate, prepareSettlementDays, publishDueTop20, readSnapshot } from './top20.mjs';

const teacherTransitions = new Map([
  ['PENDING', new Set(['CONFIRMED', 'DECLINED', 'WAITLISTED', 'NO_SHOW'])],
  ['WAITLISTED', new Set(['CONFIRMED'])],
]);

export function createAdminService(store, clock, send, onRolesChanged) {
  const { users } = store.tables;
  const roster = createRosterService(store, clock, onRolesChanged);

  function transition(actor, body) {
    const day = checkedDate(body.eventDate);
    const { userId, status } = body;
    if (actor.kind !== 'teacher' && (actor.kind !== 'student' || actor.id !== userId || status !== 'DECLINED')) {
      throw new AuthError('INTERVIEW_FORBIDDEN', '只能放弃本人邀约。', 403);
    }
    if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
      throw new AuthError('STUDENT', '请选择候选学生。');
    }
    return store.transaction(async (tx) => {
      await lockAdmin(tx);
      const interview = await tx.get(`SELECT status FROM interview_records
        WHERE event_id = ? AND event_date = ? AND user_id = ?`, eventId, day, userId);
      if (!interview) throw new AuthError('INTERVIEW', '未找到该邀约。', 404);
      const now = clock();
      if (now >= startsAt(shiftDay(day, 1))) throw new AuthError('INTERVIEW_CLOSED', '约谈处理时间已结束。', 409);
      if (!teacherTransitions.get(interview.status)?.has(status)) {
        throw new AuthError('INTERVIEW_STATE', '邀约状态已变化，请刷新后再操作。', 409);
      }
      await tx.run(`UPDATE interview_records SET status = ?, updated_at = ?
        WHERE event_id = ? AND event_date = ? AND user_id = ?`, status, now, eventId, day, userId);
      await audit(tx, actor, day, 'interview.changed', now, userId, { from: interview.status, to: status });
      return { status };
    });
  }

  function studentInterview(userId) {
    const now = clock();
    const today = eventDate(now);
    const earliest = now < startsAt(today) ? shiftDay(today, -1) : today;
    return store.read(async (tx) => await tx.get(`SELECT event_date AS eventDate FROM interview_records
      WHERE event_id = ? AND user_id = ? AND status = 'PENDING' AND event_date BETWEEN ? AND ?
      ORDER BY event_date DESC LIMIT 1`, eventId, userId, earliest, today) ?? null);
  }

  function searchStudents(value) {
    const term = typeof value === 'string' ? value.trim() : '';
    if (term.length < 2 || term.length > 64) throw new AuthError('SEARCH', '请输入 2–64 个字搜索姓名或学号。');
    const pattern = `%${term.replace(/[!%_]/g, '!$&')}%`;
    return store.read((tx) => tx.all(`SELECT u.id AS userId, u.name, u.student_id AS studentId
      FROM ${users} u JOIN event_registrations r ON r.user_id = u.id
      WHERE r.event_id = ? AND u.openid IS NOT NULL
        AND (u.name LIKE ? ESCAPE '!' OR u.student_id LIKE ? ESCAPE '!')
      ORDER BY u.student_id, u.id LIMIT 20`, eventId, pattern, pattern));
  }

  async function dashboard(body) {
    const settings = await readEventSettings(store, true);
    const now = clock();
    const lastDue = latestDueDate(now);
    const first = eventStartDate();
    const last = eventEndDate();
    const dueDate = lastDue < first ? first : lastDue > last ? last : lastDue;
    const snapshotDate = checkedDate(body.snapshotDate ?? dueDate);
    const nextDay = shiftDay(snapshotDate, 1);
    const assignmentCandidate = nextDay < first ? first : nextDay > last ? last : nextDay;
    const assignmentDate = checkedDate(body.assignmentDate ?? assignmentCandidate);
    return store.read(async (tx) => {
      const snapshot = await readSnapshot(tx, snapshotDate);
      const rows = !snapshot?.entries.length ? [] : await tx.all(`SELECT u.id AS userId, u.name, u.student_id AS studentId,
        i.status, o.status AS emailStatus FROM interview_records i JOIN ${users} u ON u.id = i.user_id
        LEFT JOIN email_outbox o ON o.event_id = i.event_id AND o.event_date = i.event_date AND o.user_id = i.user_id AND o.type = ?
        WHERE i.event_id = ? AND i.event_date = ?`, mailType, eventId, snapshotDate);
      const records = new Map(rows.map((row) => [row.userId, row]));
      const assignment = await readRoster(tx, users, assignmentDate);
      return {
        snapshotDate, assignmentDate, firstEventDate: first,
        eventStartDate: settings.startDate, eventEndDate: settings.endDate, eventDurationDays: settings.durationDays,
        eventSettingsEditable: now < startsAt(settings.startDate),
        emailEnabled: !!send,
        publicationDue: now >= publishesAt(snapshotDate),
        interviewsClosed: now >= startsAt(shiftDay(snapshotDate, 1)),
        rosterLocked: now >= startsAt(assignmentDate),
        snapshot: snapshot && { ...snapshot, entries: snapshot.entries.map((entry) => ({ ...entry, ...records.get(entry.userId) })) },
        assignment,
      };
    });
  }

  return {
    activate: roster.activate, assign: roster.assign, dashboard, searchStudents, transition, studentInterview,
    eventSettings: () => readEventSettings(store),
    saveEventSettings: (actor, body) => persistEventSettings(store, actor, body, clock()),
    prepareSettlementDays: (now) => prepareSettlementDays(store, now),
    async runJobs(onWaiting) {
      await readEventSettings(store, true);
      await roster.activate();
      await publishDueTop20(store, clock(), onWaiting);
      await deliverOutbox(store, send, clock);
    },
  };
}
