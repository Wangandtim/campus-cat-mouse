import { createHmac } from 'node:crypto';
import { audit } from '../admin/common.mjs';
import { AuthError } from '../auth/error.mjs';
import { eventDate } from '../rules.mjs';

export async function auditLoginFailure(store, channel, now, error) {
  const details = { channel, status: Number.isInteger(error?.status) ? error.status : 500 };
  try {
    await store.transaction((tx) => audit(tx, { kind: 'system', id: 'anonymous' },
      eventDate(now), 'login.failed', now, null, details));
  } catch {
    console.error('登录失败审计写入失败。');
  }
}

export function auditTeacher(actor, signingKey) {
  if (!/^\d{7,20}$/.test(actor.id.replace(/[.-]/g, ''))) return actor;
  const digest = createHmac('sha256', signingKey.trim()).update(actor.id).digest('hex');
  return { kind: actor.kind, id: `teacher-${digest.slice(0, 32)}` };
}

export function assignmentAuditFields({ eventDate, userId, replaceUserId, reason }) {
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (note.length > 200 || /\p{C}/u.test(note)) {
    throw new AuthError('ASSIGNMENT_REASON', '请填写 200 字以内的换人原因。');
  }
  return { eventDate, userId, replaceUserId, reason: note ? '已填写' : '' };
}

export async function maskStudentContacts(store, ...lists) {
  const ids = [...new Set(lists.flatMap((list) => list.map(({ userId }) => userId)))];
  if (!ids.length) return;
  const rows = await store.read((tx) => tx.all(`SELECT id, phone, email FROM ${store.tables.users}
    WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids));
  const contacts = new Map(rows.map(({ id, phone, email }) => {
    const digits = phone?.replace(/\D/g, '');
    const address = email?.split('@');
    return [id, {
      phone: phone ? `***${digits.length > 4 ? digits.slice(-4) : ''}` : null,
      email: email ? (address.length === 2 && address[0].length > 1 ? `${address[0][0]}***@${address[1]}` : '***') : null,
    }];
  }));
  for (const list of lists) {
    for (const row of list) Object.assign(row, contacts.get(row.userId));
  }
}
