import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { liveConnectionOptions } from '../../src/composables/liveConnection.ts';
import { cadence, increment, inWindow, listenForCommands, mouseCount, observe, position, processSampler,
  playerId, positionSampleKey, roleOf, sampleTime } from './metrics.mjs';

assert.ok(process.send, 'Run through tests/load/run.mjs');
const clients = new Map();
const processSample = processSampler();
let phase;
let origin;
let sessionId;
let epoch;

function armClient(index, cookie, startsAt) {
  const socket = io(origin, {
    ...liveConnectionOptions(),
    extraHeaders: { 'X-Forwarded-Proto': 'https', Cookie: cookie },
  });
  const client = { socket, connects: 0, ready: false, everReady: false, seen: new Map() };
  clients.set(index, client);
  const role = roleOf(index);
  const id = playerId(index);
  function cancelRetry() {
    clearTimeout(client.retryTimer);
    client.latest = undefined;
  }
  socket.on('connect', () => {
    client.connects++;
    client.firstConnectMs ??= Date.now() - client.connectIssuedAt;
    if (client.connects > 1 && inWindow(phase, Date.now())) {
      phase.reconnects++;
      if (socket.recovered) phase.stateRecovered++;
      if (client.lastDropAt) observe(phase.recovery, Date.now() - client.lastDropAt);
      increment(phase.reconnectBySecond, Math.floor((Date.now() - phase.start) / 1000));
    }
  });
  socket.on('connect_error', (error) => {
    const code = error.message === '活动定位暂不可用。' ? 'AUTH_SERVICE_BUSY' : error.message;
    if (inWindow(phase, Date.now())) increment(phase.connectErrors, code);
    else if (!client.connects) client.preWindowError = code;
  });
  socket.io.on('reconnect_attempt', () => {
    if (inWindow(phase, Date.now())) phase.reconnectAttempts++;
  });
  socket.on('disconnect', (reason) => {
    client.ready = false;
    client.readyAt = undefined;
    cancelRetry();
    client.seen.clear();
    client.lastDropAt = Date.now();
    if (inWindow(phase, client.lastDropAt)) increment(phase.disconnects, reason);
  });
  socket.on('live:ready', (room) => {
    client.ready = room.eventId === sessionId && room.role === role;
    cancelRetry();
    if (client.ready) {
      client.readyAt ??= Date.now();
      client.everReady = true;
    } else {
      client.readyAt = undefined;
      if (inWindow(phase, Date.now())) phase.unexpectedRoom++;
    }
  });
  socket.on('live:error', (_message, detail) => {
    if (inWindow(phase, Date.now())) increment(phase.liveErrors, detail?.code ?? 'LIVE_ERROR');
    const latest = client.latest;
    if (!latest || latest.retried || detail?.code !== 'POSITION_RETRY_RETRYABLE' ||
        detail.sampleId !== latest.point.sampleId || !Number.isFinite(detail.retryAfter) || detail.retryAfter <= 0) return;
    latest.retried = true;
    client.retryTimer = setTimeout(() => {
      if (client.latest !== latest || !client.ready || !socket.connected || !socket.io.engine.transport.writable) return;
      socket.volatile.emit('live:position', latest.point);
      if (latest.measured?.positionSamples) latest.measured.positionResends++;
    }, detail.retryAfter * 1000);
  });
  socket.on('live:positions', (eventId, markers) => {
    if (!phase || eventId !== sessionId) return;
    const now = Date.now();
    if (inWindow(phase, now)) {
      phase.snapshots++;
      if (markers.some((marker) => marker.role === role)) phase.unexpectedMarkerRole++;
      if (role === 'cat') {
        phase.catSnapshots++;
        if (markers.length === mouseCount) phase.catFull++;
      } else {
        phase.mouseSnapshots++;
        phase.mouseMaxCats = Math.max(phase.mouseMaxCats, markers.length);
      }
    }
    for (const marker of markers) {
      const at = sampleTime(marker.lat, epoch);
      if (inWindow(phase, at) && at > (client.seen.get(marker.id) ?? 0)) {
        client.seen.set(marker.id, at);
        observe(phase.visible, now - at);
      }
    }
  });
  client.connectTimer = setTimeout(() => {
    client.connectIssuedAt = Date.now();
    if (inWindow(phase, client.connectIssuedAt)) phase.dials++;
    socket.connect();
  }, Math.max(0, startsAt - Date.now()));

  // Deterministic offsets fill the 5s period and keep each client on its own cadence.
  const offset = ((index * 2654435761) >>> 0) % cadence;
  let due = epoch + offset + cadence * Math.ceil((startsAt - epoch - offset) / cadence);
  const schedule = () => { client.positionTimer = setTimeout(report, Math.max(0, due - Date.now())); };
  function recordSample(measured, outcome) {
    if (!measured?.positionSamples) return;
    const { reconnectAt } = measured;
    const stable = client.readyAt !== undefined && due >= client.readyAt + 10_000 &&
      (reconnectAt === undefined || client.readyAt >= reconnectAt);
    const window = due < reconnectAt ? 'beforeDisconnect' : stable ? 'stable' : 'admission';
    measured.positionSamples.push([positionSampleKey(id, due), window, outcome]);
  }

  function report() {
    const now = Date.now();
    cancelRetry();
    while (due + cadence <= now) {
      if (inWindow(phase, due)) {
        phase.scheduled++;
        increment(phase.skipped, 'timer');
        recordSample(phase, 'timer');
      }
      due += cadence;
    }
    const measured = inWindow(phase, due) ? phase : undefined;
    if (measured) {
      measured.scheduled++;
      observe(measured.sendLag, now - due);
    }
    if (!client.ready || !socket.connected) {
      if (measured) increment(measured.skipped, 'offline');
      recordSample(measured, 'offline');
    } else if (!socket.io.engine.transport.writable) {
      if (measured) increment(measured.skipped, 'notWritable');
      recordSample(measured, 'notWritable');
    } else {
      const point = { ...position(index, due, epoch, sessionId), sampleId: due, sampledAt: due };
      client.latest = { point, measured, retried: false };
      socket.volatile.emit('live:position', point);
      if (measured) measured.emitted++;
      recordSample(measured, 'emitted');
    }
    due += cadence;
    schedule();
  }
  schedule();
}

setInterval(() => {
  const sample = processSample();
  if (inWindow(phase, sample.at)) phase.samples.push(sample);
}, 1000);

listenForCommands({
  configure(args) {
    ({ origin, sessionId, epoch } = args);
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  },
  add({ clients: group }) {
    for (const { index, cookie, at } of group) armClient(index, cookie, at);
  },
  begin({ start, end, trackPositionSamples, reconnectAt }) {
    phase = {
      start, end, dials: 0, scheduled: 0, emitted: 0, skipped: {}, sendLag: {}, visible: {}, connectErrors: {},
      ...(trackPositionSamples && { positionSamples: [], positionResends: 0, reconnectAt }),
      disconnects: {}, liveErrors: {}, reconnects: 0, stateRecovered: 0, reconnectAttempts: 0, recovery: {}, reconnectBySecond: {},
      snapshots: 0, catSnapshots: 0, catFull: 0, mouseSnapshots: 0, mouseMaxCats: 0,
      unexpectedMarkerRole: 0, unexpectedRoom: 0, samples: [],
    };
    for (const client of clients.values()) client.seen.clear();
  },
  missing: () => [...clients.entries()].filter(([, client]) => !client.ready).map(([index]) => index),
  restore({ seats }) {
    for (const { index, at } of seats) {
      const client = clients.get(index);
      client.connectTimer = setTimeout(() => {
        if (client.ready) return;
        client.connectIssuedAt = Date.now();
        client.socket.disconnect().connect();
      }, Math.max(0, at - Date.now()));
    }
  },
  stats() {
    const sockets = [...clients.values()];
    const firstConnect = {};
    const preWindowErrors = {};
    for (const client of sockets) {
      if (client.firstConnectMs !== undefined) observe(firstConnect, client.firstConnectMs);
      if (client.preWindowError) increment(preWindowErrors, client.preWindowError);
    }
    return {
      ...phase, planned: sockets.length, active: sockets.filter(({ socket }) => socket.connected).length,
      everHandshaken: sockets.filter((client) => client.connects > 0).length,
      ready: sockets.filter((client) => client.ready).length, everReady: sockets.filter((client) => client.everReady).length,
      websocket: sockets.filter(({ socket }) => socket.connected && socket.io.engine.transport.name === 'websocket').length,
      firstConnect, preWindowErrors,
    };
  },
  clear() {
    for (const { socket, connectTimer, positionTimer, retryTimer } of clients.values()) {
      clearTimeout(connectTimer);
      clearTimeout(positionTimer);
      clearTimeout(retryTimer);
      socket.disconnect();
    }
    clients.clear();
  },
});
