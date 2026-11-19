import { resolve } from 'node:path';
import { createGame, GameError } from './game.mjs';
import { sessions } from './rules.mjs';

const profileCookie = 'campus_demo';
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

function playerIdOf(req) {
  const cookie = req.headers.cookie?.split('; ').find((part) => part.startsWith(profileCookie + '='));
  const id = cookie?.slice(profileCookie.length + 1);
  return /^[a-zA-Z0-9_-]{32}$/.test(id ?? '') ? id : undefined;
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

export function createPreviewApi(env, game = createGame(resolve('.campus', 'preview.sqlite3'))) {
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

  return async function previewApi(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/_AMapService/')) return await proxyMap(req, res, url);
      if (req.method === 'GET' && url.pathname === '/api/map-settings') {
        return json(res, 200, { amapKey: mapEnabled ? mapKey : null });
      }
      if (!url.pathname.startsWith('/api/preview/')) return json(res, 404, { message: '页面不存在。' });
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        throw new GameError('ORIGIN', '请打开本机活动预览。', 403);
      }
      let player = game.getPlayer(playerIdOf(req));
      if (url.pathname === '/api/preview/state' && req.method === 'GET') {
        if (!player) {
          player = game.join();
          res.setHeader('Set-Cookie', `${profileCookie}=${player.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600`);
        }
        return json(res, 200, game.snapshot(player));
      }
      if (!player) throw new GameError('AUTH', '请重新进入活动页面。', 401);
      if (req.method === 'GET' && url.pathname === '/api/preview/leaderboard') {
        return json(res, 200, game.leaderboard(player, url.searchParams.get('range')));
      }
      if (req.method === 'POST') {
        const body = await bodyOf(req);
        const id = req.headers['idempotency-key'];
        switch (url.pathname) {
          case '/api/preview/profile':
            return json(res, 200, game.updatePlayer(player, checkedProfile(body)));
          case '/api/preview/mouse-code':
            return json(res, 200, game.issueCode(player, null, 'mouse'));
          case '/api/preview/sample-code':
            return json(res, 200, game.issueCode(player, Number(body.mouseId), 'sample'));
          case '/api/preview/capture':
            return json(res, 200, game.capture(player, id, body.code));
          case '/api/preview/tracking':
            if (typeof body.active !== 'boolean') throw new GameError('CONTENT', '请选择开始或暂停。', 400);
            return json(res, 200, game.setTracking(player, body.active));
          case '/api/preview/move':
            return json(res, 200, game.move(player, id));
        }
      }
      return json(res, 404, { message: '页面不存在。' });
    } catch (error) {
      if (error instanceof GameError) return json(res, error.status, { code: error.code, message: error.message });
      console.error('Preview API error', error.name, error.code ?? '');
      if (!res.headersSent) return json(res, 500, { code: 'SERVER', message: '服务暂时忙，请稍后重试。' });
      res.destroy();
    }
  };
}
