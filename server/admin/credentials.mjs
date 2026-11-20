import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { AuthError } from '../auth/error.mjs';
import { readCookie, writeCookie } from '../auth/session.mjs';

const derive = promisify(scrypt);
const scryptOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const maxAge = 8 * 60 * 60;
const accountPattern = /^[A-Za-z0-9_.-]{1,64}$/;
const audience = 'campus-teacher';

function decode(value, length) {
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length >= length && decoded.toString('base64url') === value ? decoded : null;
}

function checkedCredentials(allowlist, rawHashes) {
  try {
    const accounts = allowlist.split(',').map((account) => account.trim());
    const hashes = JSON.parse(rawHashes);
    const verified = new Map();
    for (const account of accounts) {
      if (!accountPattern.test(account) || !Object.hasOwn(hashes, account) || verified.has(account)) throw new Error();
      const [saltText, hashText, extra] = hashes[account].split('.');
      const salt = decode(saltText, 16);
      const hash = decode(hashText, 64);
      if (!salt || salt.length > 64 || hash?.length !== 64 || extra !== undefined) throw new Error();
      verified.set(account, { salt, hash });
    }
    return verified;
  } catch {
    throw new Error('请检查 CAMPUS_TEACHER_ALLOWLIST 和 CAMPUS_TEACHER_PASSWORD_HASHES。');
  }
}

export function createTeacherAuth(env, clock) {
  const allowlist = env.CAMPUS_TEACHER_ALLOWLIST?.trim();
  const hashes = env.CAMPUS_TEACHER_PASSWORD_HASHES?.trim();
  const encoded = env.CAMPUS_TEACHER_JWT_SECRET?.trim();
  if (!allowlist && !hashes && !encoded) return null;
  const key = decode(encoded ?? '', 32);
  if (!key || encoded === env.CAMPUS_JWT_SECRET?.trim()) {
    throw new Error('CAMPUS_TEACHER_JWT_SECRET 必须单独生成，至少 32 随机字节，使用 base64url 编码。');
  }
  const credentials = checkedCredentials(allowlist ?? '', hashes ?? '');
  const fallback = { salt: randomBytes(16), hash: randomBytes(64) };
  const secure = !['mock', 'demo'].includes(env.CAMPUS_AUTH_MODE?.trim());
  const cookie = `${secure ? '__Host-' : ''}campus_teacher`;
  const issuer = 'campus-admin';
  let checking = 0;

  return {
    async login(res, body) {
      const { account, password } = body;
      if (typeof account !== 'string' || !accountPattern.test(account) || typeof password !== 'string' ||
          !password.length || Buffer.byteLength(password) > 256) {
        throw new AuthError('TEACHER_LOGIN', '教师账号或密码不正确。', 401);
      }
      if (checking >= 2) throw new AuthError('TEACHER_BUSY', '登录请求较多，请稍后重试。', 429);
      const record = credentials.get(account);
      const { salt, hash } = record ?? fallback;
      checking++;
      try {
        const supplied = await derive(password, salt, hash.length, scryptOptions);
        if (!timingSafeEqual(hash, supplied) || !record) {
          throw new AuthError('TEACHER_LOGIN', '教师账号或密码不正确。', 401);
        }
      } finally {
        checking--;
      }
      const now = Math.floor(clock() / 1000);
      const token = await new SignJWT({ role: 'teacher' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(issuer).setAudience(audience).setSubject(account).setJti(randomUUID())
        .setIssuedAt(now).setExpirationTime(now + maxAge).sign(key);
      writeCookie(res, cookie, token, maxAge, secure);
      return { account };
    },
    async requireTeacher(req) {
      const token = readCookie(req, cookie);
      if (token?.length && token.length <= 2048) {
        try {
          const { payload } = await jwtVerify(token, key, {
            algorithms: ['HS256'], typ: 'JWT', issuer, audience, maxTokenAge: maxAge,
            currentDate: new Date(clock()), requiredClaims: ['exp', 'iat', 'sub', 'role'],
          });
          if (payload.role === 'teacher' && credentials.has(payload.sub)) return { kind: 'teacher', id: payload.sub };
        } catch {
          // An invalid or expired cookie is treated as an anonymous request.
        }
      }
      throw new AuthError('TEACHER_AUTH', '请先登录教师账号。', 401);
    },
    logout(res) { writeCookie(res, cookie, '', 0, secure); },
  };
}
