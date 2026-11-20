import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from './error.mjs';
import { callbackPath, createMockProvider, createWechatProvider } from './providers.mjs';
import { createAuthRepository } from './repository.mjs';
import { loadRoster } from './roster.mjs';
import { createSessions, readCookie, readSigningKey, stateMaxAge, writeCookie } from './session.mjs';
import { validGender } from '../rules.mjs';

const demoCookie = 'campus_demo';
const demoPlayerId = /^[a-zA-Z0-9_-]{32}$/;
const stateValue = /^[a-zA-Z0-9_-]{43}$/;
const loopbackHost = /^127\.0\.0\.1(?::\d{1,5})?$/;
const isLoopback = (address) => address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address === '::1';

function wechatOptions(env) {
  const appId = env.WECHAT_APP_ID?.trim();
  const secret = env.WECHAT_APP_SECRET?.trim();
  if (!appId || !secret) throw new Error('微信登录必须配置 WECHAT_APP_ID 和 WECHAT_APP_SECRET。');

  const origin = URL.parse(env.CAMPUS_PUBLIC_ORIGIN?.trim() ?? '');
  if (!origin || origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`) {
    throw new Error('CAMPUS_PUBLIC_ORIGIN 必须是 HTTPS origin。');
  }
  const redirectUri = `${origin.origin}${callbackPath}`;
  const allowed = env.WECHAT_REDIRECT_ALLOWLIST?.split(',').map((entry) => entry.trim());
  if (!allowed?.includes(redirectUri)) throw new Error('WECHAT_REDIRECT_ALLOWLIST 必须包含精确的微信回调 URI。');
  return { appId, secret, origin, redirectUri };
}

function rosterOptions(env) {
  const origin = URL.parse(env.CAMPUS_PUBLIC_ORIGIN?.trim() ?? '');
  if (!origin || origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`) {
    throw new Error('CAMPUS_PUBLIC_ORIGIN 必须是 HTTPS origin。');
  }
  return { origin };
}

function checkParams(req, url, allowed) {
  if (req.url.split('?')[0] !== url.pathname ||
      [...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) {
    throw new AuthError('OAUTH_REDIRECT', '授权回调地址或参数无效。');
  }
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end();
}

function checkedGender(value) {
  if (!validGender(value)) throw new AuthError('GENDER', '请选择用于配速判定的性别。', 400);
  return value;
}

export function createAuth(env, store, clock) {
  const mode = env.CAMPUS_AUTH_MODE?.trim() || 'wechat';
  if (!['wechat', 'mock', 'demo', 'roster'].includes(mode)) {
    throw new Error('CAMPUS_AUTH_MODE 必须为 wechat、mock、demo 或 roster。');
  }
  const secure = mode === 'wechat' || (mode === 'roster' && env.NODE_ENV === 'production');
  const demo = mode === 'demo';
  if (!secure && !['development', 'test'].includes(env.NODE_ENV)) {
    throw new Error('mock/demo 只允许在 development 或 test 显式启用，production 必须配置微信或 roster。');
  }

  const options = mode === 'wechat' ? wechatOptions(env)
    : mode === 'roster' && secure ? rosterOptions(env) : undefined;
  const provider = mode === 'wechat' ? createWechatProvider(options)
    : mode === 'mock' ? createMockProvider() : undefined;
  const sessions = !demo && createSessions(readSigningKey(env.CAMPUS_JWT_SECRET), options?.origin.origin ?? 'urn:campus:mock', secure, clock);
  const verifyStudent = !demo && loadRoster(env.CAMPUS_ROSTER_CSV?.trim(), !secure);
  const repository = createAuthRepository(store);
  const stateCookie = `${secure ? '__Host-' : ''}campus_state`;

  function originOf(req) {
    const { host } = req.headers;
    const local = isLoopback(req.socket.remoteAddress);
    if (secure) {
      // The standalone server binds to loopback. The HTTPS proxy must overwrite this header.
      const https = req.socket.encrypted || (local && req.headers['x-forwarded-proto'] === 'https');
      if (https && host === options.origin.host) return options.origin.origin;
    } else if (local && loopbackHost.test(host ?? '') && !req.headers.forwarded &&
        !req.headers['x-forwarded-proto'] && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-for']) {
      return `${req.socket.encrypted ? 'https' : 'http'}://${host}`;
    }
  }

  return {
    mode,
    demo,
    checkRequest(req) {
      const origin = originOf(req);
      if (!origin) throw new AuthError(secure ? 'HTTPS_REQUIRED' : 'LOCAL_ONLY',
        secure ? '请使用活动的 HTTPS 地址。' : '请打开本机活动预览。', 403);
      if (req.method !== 'POST') return;
      if (demo && env.NODE_ENV === 'test' && req.headers.origin === undefined) return;
      if (req.headers.origin !== origin) throw new AuthError('ORIGIN', '请从活动页面提交。', 403);
    },
    async playerId(req) {
      if (!originOf(req)) return;
      if (demo) {
        const id = readCookie(req, demoCookie);
        return demoPlayerId.test(id ?? '') ? id : undefined;
      }
      const session = await sessions.read(req);
      return session?.kind === 'player' ? session.id : undefined;
    },
    startDemo(res, id) { writeCookie(res, demoCookie, id, 14 * 24 * 60 * 60, false); },
    async status(req) {
      if (demo) return { mode, status: 'demo' };
      const session = await sessions.read(req);
      if (!session || (session.kind === 'registration' && !await repository.getPending(session.id, clock()))) {
        return { mode, status: 'anonymous' };
      }
      if (session.kind === 'registration') {
        return { mode, status: session.kind, expiresIn: session.expiresIn, prefill: session.roster };
      }
      const profile = await repository.genderOf(session.id);
      if (!profile) return { mode, status: 'anonymous' };
      return { mode, status: 'player', expiresIn: session.expiresIn, needsGender: !validGender(profile.gender) };
    },
    async rosterLogin(req, res, body) {
      if (mode !== 'roster') throw new AuthError('NOT_FOUND', '当前未启用学号登录。', 404);
      const student = verifyStudent.lookup({ school: '西安欧亚学院', ...body });
      const openid = `roster:${student.studentNo}`;
      const player = await repository.findByOpenId(openid);
      if (player) {
        await sessions.write(res, 'player', player.id);
        return { mode, status: 'player' };
      }
      const now = clock();
      const pending = await repository.newPending(openid, now, now + stateMaxAge * 1000);
      await sessions.write(res, 'registration', pending, { roster: student });
      return { mode, status: 'registration', expiresIn: stateMaxAge, prefill: student };
    },
    async login(req, res, url) {
      if (mode !== 'wechat' && mode !== 'mock') throw new AuthError('NOT_FOUND', '当前未启用微信登录。', 404);
      checkParams(req, url, secure ? [] : ['account']);
      const state = randomBytes(32).toString('base64url');
      const location = provider.authorizationUrl({ state, account: url.searchParams.get('account') ?? 'campus-preview' });
      const now = clock();
      await repository.saveState(state, now, now + stateMaxAge * 1000);
      writeCookie(res, stateCookie, state, stateMaxAge, secure);
      redirect(res, location);
    },
    async callback(req, res, url) {
      if (mode !== 'wechat' && mode !== 'mock') throw new AuthError('NOT_FOUND', '当前未启用微信登录。', 404);
      checkParams(req, url, ['code', 'state']);
      const state = url.searchParams.get('state');
      const cookie = readCookie(req, stateCookie);
      if (!stateValue.test(state ?? '') || !stateValue.test(cookie ?? '') ||
          !timingSafeEqual(Buffer.from(state), Buffer.from(cookie)) || !await repository.consumeState(state, clock())) {
        throw new AuthError('OAUTH_STATE', '授权已失效，请返回活动首页重新登录。');
      }
      writeCookie(res, stateCookie, '', 0, secure);
      const code = url.searchParams.get('code');
      if (!code || !/^[a-zA-Z0-9_-]{1,256}$/.test(code) || code === 'authdeny') {
        throw new AuthError('OAUTH_CALLBACK', '微信授权未完成，请返回活动首页重试。');
      }
      const openid = await provider.exchange(code);
      const player = await repository.findByOpenId(openid);
      if (player) {
        await sessions.write(res, 'player', player.id);
      } else {
        const now = clock();
        const pending = await repository.newPending(openid, now, now + stateMaxAge * 1000);
        await sessions.write(res, 'registration', pending);
      }
      redirect(res, '/');
    },
    async register(req, res, body) {
      const session = await sessions.read(req);
      if (session?.kind === 'player') throw new AuthError('ALREADY_REGISTERED', '你已报名本活动。', 409);
      const pending = session && await repository.getPending(session.id, clock());
      if (!pending) throw new AuthError('AUTH', '请先重新登录。', 401);
      const student = verifyStudent(body);
      if (session.roster && (student.studentNo !== session.roster.studentNo ||
          student.name !== session.roster.name || student.school !== session.roster.school)) {
        throw new AuthError('ROSTER_SESSION', '学号登录信息已变化，请重新登录。', 409);
      }
      const id = await repository.bind(pending.openid, { ...student, gender: checkedGender(body.gender) }, clock());
      return { mode, ...await sessions.write(res, 'player', id) };
    },
    async completeGender(req, body) {
      const session = await sessions.read(req);
      if (session?.kind !== 'player') throw new AuthError('AUTH', '请先重新登录微信。', 401);
      await repository.completeGender(session.id, checkedGender(body.gender));
      return { mode, status: 'player', expiresIn: session.expiresIn, needsGender: false };
    },
    logout(res) {
      sessions.clear(res);
      writeCookie(res, stateCookie, '', 0, secure);
      return { mode, status: 'anonymous' };
    },
  };
}
