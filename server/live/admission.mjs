import { ServerResponse } from 'node:http';

const playerOnRequest = Symbol('live handshake player');

export function sameOrigin({ headers: { origin, host } }) {
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
}

export function admitLiveConnections(io, preparePlayer, { maxPending = 96, retryAfter = 1 } = {}) {
  let pending = 0;
  let busy = 0;
  let accepted = 0;
  let peakPending = 0;

  function unavailable(req, res) {
    if (req.socket.destroyed) return;
    if (res instanceof ServerResponse) {
      if (res.writableEnded) return;
      res.writeHead(503, { 'Retry-After': retryAfter, 'Cache-Control': 'no-store', 'Content-Length': 0 }).end();
    } else if (req.socket.writable) {
      // Engine.IO's middleware response for an upgrade cannot send an HTTP status.
      req.socket.end(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${retryAfter}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    } else return;
    busy++;
  }

  io.engine.use((req, res, next) => {
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    if (!sameOrigin(req) || req.method !== 'GET' || query.has('sid') ||
        query.get('EIO') !== '4' || !['polling', 'websocket'].includes(query.get('transport'))) return next();
    if (pending >= maxPending) return unavailable(req, res);
    pending++;
    peakPending = Math.max(peakPending, pending);
    void Promise.resolve().then(() => preparePlayer(req)).then((player) => {
      if (req.socket.destroyed) return;
      req[playerOnRequest] = player;
      next();
    }, () => {
      if (!req.socket.destroyed) unavailable(req, res);
    }).finally(() => { pending--; });
  });

  io.use((socket, next) => {
    const player = socket.request[playerOnRequest];
    if (!player || (socket.recovered && socket.data.player?.id !== player.id)) {
      return next(new Error('请重新进入活动页面。'));
    }
    socket.data.player = player;
    next();
  });

  io.engine.on('connection', () => { accepted++; });
  return () => ({ limit: maxPending, pending, peakPending, busy, accepted });
}
