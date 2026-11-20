import { createHash, randomBytes } from 'node:crypto';
import { eventId } from '../db/migrations.mjs';
import { AuthError } from './error.mjs';

const hashState = (state) => createHash('sha256').update(state).digest('hex');
const newId = () => randomBytes(24).toString('base64url');

export function createAuthRepository(store) {
  const { users } = store.tables;
  const findByOpenId = (openid) => store.read((db) => db.get(`SELECT id FROM ${users} WHERE openid = ?`, openid));

  async function bind(openid, { name, studentNo, grade, college, className, phone, email, gender }, now) {
    const id = newId();
    try {
      await store.transaction(async (db) => {
        await db.run(`INSERT INTO ${users} (id, nickname, role, created_at, openid,
          name, student_id, grade, college, class_name, phone, email, gender)
          VALUES (?, '欧亚学生', 'cat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, now, openid, name, studentNo, grade, college, className, phone, email, gender);
        await db.run('INSERT INTO event_registrations (user_id, event_id, created_at) VALUES (?, ?, ?)', id, eventId, now);
      });
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY' && error.errcode !== 2067) throw error;
      // Inspect the committed winner after the failed transaction has rolled back.
      if (await findByOpenId(openid)) throw new AuthError('OPENID_BOUND', '该微信账号已绑定，请重新登录。', 409);
      const student = await store.read((db) => db.get(`SELECT id FROM ${users} WHERE student_id = ?`, studentNo));
      if (student) throw new AuthError('STUDENT_BOUND', '该学号已绑定微信账号，请联系活动管理员。', 409);
      throw error;
    }
    return id;
  }

  return {
    findByOpenId,
    bind,
    genderOf: (id) => store.read((db) => db.get(
      `SELECT gender FROM ${users} WHERE id = ? AND openid IS NOT NULL`, id)),
    completeGender: (id, gender) => store.transaction(async (db) => {
      await db.lockPlayers([id]);
      const row = await db.get(`SELECT gender FROM ${users} WHERE id = ? AND openid IS NOT NULL`, id);
      if (!row) throw new AuthError('AUTH', '请先重新登录微信。', 401);
      if (row.gender === gender) return;
      if (row.gender !== 'unknown') throw new AuthError('GENDER_EXISTS', '性别已登记。', 409);
      await db.run(`UPDATE ${users} SET gender = ? WHERE id = ?`, gender, id);
    }),
    saveState: (state, now, expiresAt) => store.transaction(async (db) => {
      await db.run('DELETE FROM oauth_states WHERE expires_at <= ?', now);
      await db.run('INSERT INTO oauth_states (state_hash, expires_at) VALUES (?, ?)', hashState(state), expiresAt);
    }),
    consumeState: (state, now) => store.transaction(async (db) => {
      const result = await db.run('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ?', hashState(state), now);
      return (result.affectedRows ?? result.changes) === 1;
    }),
    newPending: (openid, now, expiresAt) => store.transaction(async (db) => {
      const id = newId();
      await db.run('DELETE FROM pending_registrations WHERE expires_at <= ?', now);
      await db.run('INSERT INTO pending_registrations (id, openid, expires_at) VALUES (?, ?, ?)', id, openid, expiresAt);
      return id;
    }),
    getPending: (id, now) => store.read((db) => db.get('SELECT openid FROM pending_registrations WHERE id = ? AND expires_at > ?', id, now)),
  };
}
