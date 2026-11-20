import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const stateMaxAge = 600;
const sessionMaxAge = 8 * 60 * 60;
const audience = 'campus-h5';
const algorithm = 'HS256';
const playerId = /^[a-zA-Z0-9_-]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readCookie(req, name) {
  const prefix = `${name}=`;
  const cookies = req.headers.cookie?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(prefix));
  return cookies?.length === 1 ? cookies[0].slice(prefix.length) : undefined;
}

export function writeCookie(res, name, value, maxAge, secure) {
  res.appendHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

export function readSigningKey(value) {
  const encoded = value?.trim() ?? '';
  const key = Buffer.from(encoded, 'base64url');
  if (key.length < 32 || key.toString('base64url') !== encoded) {
    throw new Error('CAMPUS_JWT_SECRET 必须是至少 32 字节随机值的 base64url 编码。');
  }
  return key;
}

export function createSessions(key, issuer, secure, clock) {
  const sessionCookie = `${secure ? '__Host-' : ''}campus_session`;
  const now = () => Math.floor(clock() / 1000);

  return {
    async read(req) {
      const token = readCookie(req, sessionCookie);
      if (!token || token.length > 2048) return;
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [algorithm], typ: 'JWT', issuer, audience,
          requiredClaims: ['sub', 'exp', 'iat', 'jti', 'kind'], maxTokenAge: sessionMaxAge,
          currentDate: new Date(clock()),
        });
        const { kind, sub, exp, iat, jti } = payload;
        if (kind !== 'player' && kind !== 'registration') return;
        const lifetime = kind === 'player' ? sessionMaxAge : stateMaxAge;
        if (typeof sub !== 'string' || !playerId.test(sub) || typeof jti !== 'string' || !uuid.test(jti) ||
            !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > lifetime) return;
        return { kind, id: sub, expiresIn: exp - now(), roster: payload.roster };
      } catch {
        return undefined;
      }
    },
    async write(res, kind, id, extra = {}) {
      const maxAge = kind === 'player' ? sessionMaxAge : stateMaxAge;
      const issuedAt = now();
      const claims = { kind };
      if (kind === 'registration' && extra.roster) claims.roster = extra.roster;
      const jwt = await new SignJWT(claims).setProtectedHeader({ alg: algorithm, typ: 'JWT' })
        .setIssuer(issuer).setAudience(audience).setSubject(id).setJti(randomUUID())
        .setIssuedAt(issuedAt).setExpirationTime(issuedAt + maxAge).sign(key);
      writeCookie(res, sessionCookie, jwt, maxAge, secure);
      return { status: kind, expiresIn: maxAge };
    },
    clear(res) { writeCookie(res, sessionCookie, '', 0, secure); },
  };
}
