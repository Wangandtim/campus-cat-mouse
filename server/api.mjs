import { resolve } from 'node:path';
import { createTeacherAuth } from './admin/credentials.mjs';
import { createMailTransport } from './admin/outbox.mjs';
import { createAdminService } from './admin/service.mjs';
import { createAuth } from './auth/index.mjs';
import { AuthError } from './auth/error.mjs';
import { openPositionStore, openSqliteStore } from './database.mjs';
import { downloadClassReport } from './export/download.mjs';
import { createGame, GameError } from './game.mjs';
import { activeEvent, sessions, validPosition } from './rules.mjs';
import { assignmentAuditFields, auditLoginFailure, auditTeacher, maskStudentContacts } from './security/admin-privacy.mjs';
import { positionForResponse, purgeLocationData, readLivePlayers } from './security/locations.mjs';
import { createRateLimiter } from './security/rate-limit.mjs';

const browserRequest = Symbol('browser request');
const previewServices = new WeakMap();
const mapUpstreams = new Map([
  ['/v4/map/styles', 'https://webapi.amap.com'],
  ['/v3/ip', 'https://restapi.amap.com'],
  ['/v3/log/init', 'https://restapi.amap.com'],
]);

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function bodyOf(req) {
  if ((req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') {
    throw new GameError('CONTENT', '请从活动页面提交。', 415);
  }
  req.setEncoding('utf8');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new GameError('CONTENT', '请求内容过长。', 413);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new GameError('CONTENT', '请求格式不正确。', 400);
  }
}

export function playerIdOf(req) {
  return { [browserRequest]: req };
}

function checkedProfile(body) {
  const profile = {};
  if (Object.hasOwn(body, 'role')) {
    if (!['cat', 'mouse'].includes(body.role)) throw new GameError('ROLE', '请选择提供的体验角色。', 400);
    profile.role = body.role;
  }
  if (Object.hasOwn(body, 'stage')) {
    if (!Object.hasOwn(sessions, body.stage)) throw new GameError('SESSION', '请选择早场或晚场。', 400);
    profile.stage = body.stage;
  }
  if (Object.hasOwn(body, 'sharing')) {
    if (typeof body.sharing !== 'boolean') throw new GameError('CONTENT', '共享状态无效。', 400);
    profile.sharing = body.sharing;
  }
  if (Object.hasOwn(body, 'nickname')) {
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    if (nickname.length < 2 || nickname.length > 16 || /[\p{C}]/u.test(nickname)) {
      throw new GameError('NAME', '昵称需为 2–16 个可见字符。', 400);
    }
    profile.nickname = nickname;
  }
  return profile;
}

export function checkedPosition(body) {
  const position = body ?? {};
  if (!validPosition(position)) {
    throw new GameError('POSITION', '请提交有效的坐标和定位精度。', 400);
  }
  const { lat, lng, accuracy } = position;
  return { lat, lng, accuracy };
}

export function openPreview(filename = resolve('.campus', 'preview.sqlite3'), positions, clock = Date.now) {
  return createPreviewServices(openSqliteStore(filename), clock, positions);
}

export function createPreviewServices(store, clock = Date.now, positions = openPositionStore(store, clock)) {
  const game = createGame(store, clock);
  const { getPlayer } = game;
  const context = { store, clock, auth: undefined, activateRoster: undefined };
  // HTTP and the existing Socket.IO handshake pass a request. Game code uses its internal player ID.
  game.getPlayer = async (id) => {
    const req = id?.[browserRequest];
    const playerId = req ? await context.auth?.playerId(req) : id;
    if (playerId && !context.auth?.demo) await context.activateRoster?.();
    return getPlayer(playerId);
  };
  previewServices.set(game, context);
  const liveGame = {
    authenticate: (req) => context.auth?.playerId(req),
    async getPlayers(ids, now, lane) {
      if (!context.auth?.demo) await context.activateRoster?.();
      return readLivePlayers(store, ids, now, lane);
    },
  };
  return { store, game, liveGame, positions, close: store.close,
    purgeLocations: (now = clock(), retentionMs) => purgeLocationData(store, now, retentionMs) };
}

export function createPreviewApi(env, game, positions, onProfileChange, checkLimit) {
  if (game === undefined) {
    ({ game, positions } = openPreview(undefined, positions));
  }
  const context = previewServices.get(game);
  const options = { ...process.env, ...env };
  checkLimit ??= createRateLimiter({ env: options, clock: context.clock });
  const auth = createAuth(options, context.store, context.clock);
  game.setAutoStage?.(auth.mode === 'roster');
  const teacher = createTeacherAuth(options, context.clock);
  const admin = teacher && createAdminService(context.store, context.clock, createMailTransport(options),
    (ids) => { for (const id of ids) onProfileChange?.(id); });
  context.auth = auth;
  context.activateRoster = admin?.activate;
  const mapKey = env.AMAP_JS_KEY?.trim();
  const mapSecret = env.AMAP_SECURITY_CODE?.trim();
  const mapEnabled = !!(mapKey && mapSecret);

  async function proxyMap(req, res, url) {
    const path = url.pathname.slice('/_AMapService'.length);
    const upstreamHost = mapUpstreams.get(path);
    if (req.method !== 'GET' || !mapEnabled || !upstreamHost || url.search.length > 2500) {
      return json(res, 404, { message: '此地图服务不可用。' });
    }
    const upstream = new URL(path + url.search, upstreamHost);
    if (upstream.searchParams.has('key') && upstream.searchParams.get('key') !== mapKey) {
      return json(res, 403, { message: '地图请求与预览配置不匹配。' });
    }
    upstream.searchParams.set('key', mapKey);
    upstream.searchParams.set('jscode', mapSecret);
    try {
      const response = await fetch(upstream, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) json(res, 502, { message: '地图服务暂时无法连接。' });
      else res.destroy();
    }
  }

  function checkTeacherRequest(req) {
    if (!req.headers.origin) throw new AuthError('ORIGIN', '请从教师页面提交。', 403);
    auth.checkRequest(req);
    if (!teacher) throw new AuthError('TEACHER_DISABLED', '教师入口尚未配置。', 503);
  }

  async function teacherApi(req, res, path) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/api/admin/export') {
      let actor;
      return downloadClassReport(context.store, context.clock, res, async () => {
        if (req.method !== 'POST') throw new AuthError('METHOD', '请从教师页面提交。', 405);
        checkTeacherRequest(req);
        actor = await teacher.requireTeacher(req);
        return auditTeacher(actor, options.CAMPUS_TEACHER_JWT_SECRET);
      }, async () => {
        await checkLimit('export', req, actor.id);
        return bodyOf(req);
      });
    }
    if (req.method !== 'POST') return json(res, 405, { message: '请从教师页面提交。' });
    checkTeacherRequest(req);
    if (path === '/api/teacher/login') {
      const body = await bodyOf(req);
      const account = typeof body.account === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(body.account) ? body.account : undefined;
      await checkLimit('teacherLogin', req, account);
      return json(res, 200, await teacher.login(res, body));
    }
    const actor = await teacher.requireTeacher(req);
    await checkLimit.requireRedis();
    switch (path) {
      case '/api/admin/session': return json(res, 200, { account: actor.id });
      case '/api/admin/event':
        return json(res, 200, await admin.saveEventSettings(auditTeacher(actor, options.CAMPUS_TEACHER_JWT_SECRET), await bodyOf(req)));
      case '/api/admin/logout':
        teacher.logout(res);
        return json(res, 200, {});
      case '/api/admin/dashboard': {
        await admin.activate();
        const dashboard = await admin.dashboard(await bodyOf(req));
        await maskStudentContacts(context.store, dashboard.assignment.rows, dashboard.assignment.reserve, dashboard.snapshot?.entries ?? []);
        return json(res, 200, dashboard);
      }
      case '/api/admin/students': {
        const students = await admin.searchStudents((await bodyOf(req)).query);
        await maskStudentContacts(context.store, students);
        return json(res, 200, students);
      }
      case '/api/admin/assignments':
        return json(res, 200, await admin.assign(auditTeacher(actor, options.CAMPUS_TEACHER_JWT_SECRET), assignmentAuditFields(await bodyOf(req))));
      case '/api/admin/interviews':
        return json(res, 200, await admin.transition(auditTeacher(actor, options.CAMPUS_TEACHER_JWT_SECRET), await bodyOf(req)));
      default: return json(res, 404, { message: '页面不存在。' });
    }
  }

  async function previewApi(req, res) {
    let loginChannel;
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/_AMapService/')) return await proxyMap(req, res, url);
      if (req.method === 'GET' && url.pathname === '/api/map-settings') {
        return json(res, 200, { amapKey: mapEnabled ? mapKey : null });
      }
      if (url.pathname === '/api/teacher/login' || /^\/api\/admin(?:\/|$)/.test(url.pathname)) {
        if (req.method === 'POST' && url.pathname === '/api/teacher/login') loginChannel = 'teacher';
        return await teacherApi(req, res, url.pathname);
      }
      const authRoute = url.pathname.startsWith('/api/auth/');
      if (!authRoute && !url.pathname.startsWith('/api/preview/')) return json(res, 404, { message: '页面不存在。' });
      if (!auth.demo && req.method === 'GET' && ['/api/auth/login', '/api/auth/callback'].includes(url.pathname)) {
        loginChannel = 'oauth';
      }
      auth.checkRequest(req);
      if (authRoute) {
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.method === 'GET' && url.pathname === '/api/auth/session') {
          return json(res, 200, await auth.status(req));
        }
        if (!auth.demo) {
          switch (`${req.method} ${url.pathname}`) {
            case 'GET /api/auth/login':
              await checkLimit.requireRedis();
              return await auth.login(req, res, url);
            case 'GET /api/auth/callback':
              await checkLimit('oauthCallback', req, await auth.playerId(req));
              return await auth.callback(req, res, url);
            case 'POST /api/auth/roster':
              await checkLimit.requireRedis();
              loginChannel = 'roster';
              return json(res, 200, await auth.rosterLogin(req, res, await bodyOf(req)));
            case 'POST /api/auth/register':
              await checkLimit.requireRedis();
              return json(res, 201, await auth.register(req, res, await bodyOf(req)));
            case 'POST /api/auth/gender': return json(res, 200, await auth.completeGender(req, await bodyOf(req)));
            case 'POST /api/auth/logout': {
              const player = await game.getPlayer(playerIdOf(req));
              await game.exitParticipation(player);
              if (player?.registered) await onProfileChange?.(player.id);
              return json(res, 200, auth.logout(res));
            }
          }
        }
        return json(res, 404, { message: '页面不存在。' });
      }
      let player = await game.getPlayer(playerIdOf(req));
      if (url.pathname === '/api/preview/state' && req.method === 'GET') {
        if (!player && auth.demo) {
          player = await game.join();
          auth.startDemo(res, player.id);
        }
      }
      if (!player) throw new GameError('AUTH', '请重新进入活动页面。', 401);
      if (url.pathname === '/api/preview/state' && req.method === 'GET') {
        return json(res, 200, { ...await game.snapshot(player), livePositions: !!onProfileChange });
      }
      if (url.pathname === '/api/preview/position' && positions) {
        if (req.method === 'GET') {
          return json(res, 200, await positionForResponse(context.store, player, await positions.get(player.id), context.clock));
        }
        if (req.method === 'POST') {
          await checkLimit('position', req, player.id);
          const body = await bodyOf(req);
          const coordinates = checkedPosition(body);
          const gap = ['hidden', 'gps'].includes(body.gap) ? body.gap : undefined;
          const session = player.registered && activeEvent(player.stage, context.clock());
          if (player.registered && !session) throw new GameError('INACTIVE', '当前未开启本场运动记录。');
          const position = await positions.save(player.id, coordinates, undefined, body.sessionId ?? session?.id, gap);
          if (!position) throw new GameError('INACTIVE', '当前未开启本场运动记录。');
          return json(res, 200, await positionForResponse(context.store, player, position, context.clock));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/preview/leaderboard') {
        return json(res, 200, await game.leaderboard(player, url.searchParams.get('range')));
      }
      if (req.method === 'POST') {
        if (url.pathname === '/api/preview/capture') await checkLimit('capture', req, player.id);
        const body = await bodyOf(req);
        const id = req.headers['idempotency-key'];
        switch (url.pathname) {
          case '/api/preview/interview':
            if (Object.keys(body).length) throw new AuthError('INTERVIEW_FORBIDDEN', '只能查看本人邀约。', 403);
            return json(res, 200, { interview: player.registered ? await admin?.studentInterview(player.id) ?? null : null });
          case '/api/preview/interview/decline':
            if (!admin || !player.registered || Object.keys(body).some((field) => field !== 'eventDate')) {
              throw new AuthError('INTERVIEW_FORBIDDEN', '只能放弃本人邀约。', 403);
            }
            return json(res, 200, await admin.transition({ kind: 'student', id: player.id },
              { eventDate: body.eventDate, userId: player.id, status: 'DECLINED' }));
          case '/api/preview/profile': {
            if (!auth.demo && Object.hasOwn(body, 'role')) throw new AuthError('ROLE', '鼠阵营由教师任命。', 403);
            if (auth.mode === 'roster' && Object.hasOwn(body, 'stage')) throw new AuthError('STAGE', '场次由活动时间决定。', 403);
            const result = await game.updatePlayer(player, checkedProfile(body));
            if (result.profile.role !== player.role || result.stage.id !== player.stage ||
                result.profile.sharing !== !!player.sharing) await onProfileChange?.(player.id);
            return json(res, 200, result);
          }
          case '/api/preview/mouse-code':
            return json(res, 200, await game.issueCode(player, null, 'mouse'));
          case '/api/preview/sample-code':
            return json(res, 200, await game.issueCode(player, Number(body.mouseId), 'sample'));
          case '/api/preview/capture':
            return json(res, 200, await game.capture(player, id, body.code));
          case '/api/preview/tracking': {
            if (body.action === 'gap' && ['hidden', 'gps'].includes(body.reason) && typeof body.sessionId === 'string') {
              await game.dataGap(player, body.sessionId, body.reason);
              return json(res, 200, {});
            }
            if (body.action === 'exit' && typeof body.sessionId === 'string') {
              await game.exitParticipation(player, body.sessionId);
              if (player.registered) await onProfileChange?.(player.id);
              return json(res, 200, await game.snapshot(player));
            }
            if (typeof body.active !== 'boolean') throw new GameError('CONTENT', '请选择开始或暂停。', 400);
            const state = await game.setTracking(player, body.active, body.sessionId);
            if (player.registered) await onProfileChange?.(player.id);
            return json(res, 200, state);
          }
          case '/api/preview/move':
            return json(res, 200, await game.move(player, id));
        }
      }
      return json(res, 404, { message: '页面不存在。' });
    } catch (error) {
      if (loginChannel) await auditLoginFailure(context.store, loginChannel, context.clock(), error);
      if (res.destroyed) return;
      if (error instanceof GameError || error instanceof AuthError) {
        if (error.status === 429) res.setHeader('Retry-After', error.retryAfter ?? 1);
        if (loginChannel === 'oauth' && error.code === 'RATE_UNAVAILABLE' && req.headers.accept?.includes('text/html')) {
          res.writeHead(503, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          return res.end(error.message);
        }
        return json(res, error.status, { code: error.code, message: error.message });
      }
      console.error('活动接口处理失败。');
      if (!res.headersSent) return json(res, 500, { code: 'SERVER', message: '服务暂时忙，请稍后重试。' });
      res.destroy();
    }
  }
  return Object.assign(previewApi, { admin });
}
