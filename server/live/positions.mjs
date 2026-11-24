import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from 'socket.io';
import campus from '../../src/data/campus.json' with { type: 'json' };
import { checkedPosition } from '../api.mjs';
import { GameError } from '../game.mjs';
import { activeEvent } from '../rules.mjs';
import { admitLiveConnections, sameOrigin } from './admission.mjs';
import { createGeoIndex, isNearby } from './geo.mjs';
import { createLivePlayerCache } from './player-cache.mjs';
import { openLiveInvalidations } from './redis.mjs';

const snapshotIntervalMs = 1000;
const positionLifetimeMs = 15_000;
const positionUnavailable = '活动定位暂不可用。';
const poolBusyMessages = new Set([
  'Database queue is full.', 'Database queue timed out.', 'Queue limit reached.', 'No connections available.',
  '服务繁忙，请稍后重试',
]);
const mouseLimit = new Set(campus.zones.flatMap((zone) => zone.mice)).size;

// The preview player ID is also the session credential.
const publicId = (playerId) => createHash('sha256').update(playerId).digest('base64url').slice(0, 22);

function isTemporaryWriteError(error) {
  return error?.code === 'DB_BUSY' || error?.code === 'SQLITE_BUSY' ||
    (error?.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) === 5) ||
    poolBusyMessages.has(error?.message) || /^(数据库|服务)?(暂时|临时)(忙|繁忙)([，,。.]|$)/.test(error?.message);
}

function newestPositions(points) {
  const byPlayer = new Map();
  for (const point of points) {
    const previous = byPlayer.get(point.id);
    if (!previous || point.updatedAt > previous.updatedAt) byPlayer.set(point.id, point);
  }
  return [...byPlayer.values()];
}

const positionWriteBehind = process.env.CAMPUS_POSITION_WRITE_BEHIND === '1' ||
  (process.env.CAMPUS_POSITION_WRITE_BEHIND !== '0' && process.env.NODE_ENV === 'production');

export function attachLivePositions(httpServer, {
  game, positions, redis, clock = Date.now,
  writeBehind = positionWriteBehind,
}) {
  const cache = createLivePlayerCache(game.getPlayers);
  const writeShards = 32;
  const writeQueues = Array.from({ length: writeShards }, () => ({ jobs: [], writing: false }));
  const maxWriteQueuePerShard = 10_000;
  let writeQueueDrops = 0;
  let writeQueueRetries = 0;
  const io = new Server(httpServer, {
    connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: false },
    maxHttpBufferSize: 4096,
    allowRequest(req, done) {
      done(null, sameOrigin(req));
    },
  });

  const index = createGeoIndex(redis);
  const instanceId = randomUUID();
  const peers = new Map();
  const invalidated = new Map();
  let sending = false;
  let stopped = false;
  let recovery = 0;
  let redisIndexedSince = -Infinity;

  function scope() {
    const now = clock();
    const morning = activeEvent('morning', now);
    const evening = activeEvent('evening', now);
    return { now, id: morning?.id ?? evening?.id ?? '', events: { morning, evening } };
  }

  function clearPosition(peer) {
    if (!peer.point) return;
    void index.remove(peer.context.event, peer.point);
    peer.point = undefined;
  }

  function discardReports(peer) {
    peer.generation++;
    peer.latestReport = undefined;
    peer.pendingReport = undefined;
  }

  function isLatestReport(peer, report) {
    return peer.socket.connected && peer.latestReport === report && peer.generation === report.generation &&
      clock() < report.receivedAt + positionLifetimeMs;
  }

  async function drainPositions(peer) {
    peer.writing = true;
    try {
      while (peer.socket.connected && peer.pendingReport) {
        const report = peer.pendingReport;
        peer.pendingReport = undefined;
        try {
          await updatePosition(peer, report);
        } catch (error) {
          if (isLatestReport(peer, report)) {
            peer.socket.emit('live:error', error instanceof GameError ? error.message : positionUnavailable);
          }
        } finally {
          if (peer.latestReport === report && peer.pendingReport !== report && !report.resendAvailable) {
            peer.latestReport = undefined;
          }
        }
      }
    } finally {
      peer.writing = false;
    }
  }

  function queuePosition(peer, payload) {
    const { socket } = peer;
    const { sampleId, sampledAt } = payload ?? {};
    const identified = sampleId !== undefined || sampledAt !== undefined;
    if (identified && (!Number.isSafeInteger(sampleId) || sampleId <= 0 ||
        !Number.isSafeInteger(sampledAt) || sampledAt <= 0)) {
      socket.emit('live:error', '请提交有效的定位。');
      return;
    }

    const last = socket.data.positionSample;
    let report;
    if (identified && last && (sampleId <= last.sampleId || sampledAt <= last.sampledAt)) {
      report = peer.latestReport;
      if (!report?.resendAvailable || !isLatestReport(peer, report) ||
          sampleId !== report.sampleId || sampledAt !== report.sampledAt) return;
      report.resendAvailable = false;
      report.resent = true;
    } else {
      // Socket.IO can restore the watermark on reconnect without retaining coordinates.
      if (identified) socket.data.positionSample = { sampleId, sampledAt };
      report = { payload, sampleId, sampledAt, generation: peer.generation, receivedAt: clock() };
    }
    peer.latestReport = report;
    peer.pendingReport = report;
    if (!peer.writing) void drainPositions(peer);
  }

  function applyRoom(peer, player, current) {
    if (!peer.socket.connected) return;
    const event = player?.sharing ? current.events[player.stage] : null;
    const room = event && (player.role === 'cat'
      ? `event:${event.id}:cats`
      : `event:${event.id}:mice:${peer.id}`);
    if (peer.context !== undefined && peer.context?.room === (room || undefined)) {
      if (peer.point && player?.sharing_since > peer.point.updatedAt) clearPosition(peer);
      return;
    }

    clearPosition(peer);
    if (peer.context) {
      discardReports(peer);
      peer.socket.leave(peer.context.room);
    }
    peer.context = room ? { room, event, role: player.role, registered: player.registered } : null;
    if (room) peer.socket.join(room);
    peer.socket.emit('live:ready', {
      eventId: event?.id ?? null, endsAt: event?.endsAt ?? 0, role: player?.role ?? peer.socket.data.player.role,
    });
  }

  function syncRoom(peer, current, lane = 'broadcast', refresh = false) {
    const cached = cache.peek(peer.id, current.id);
    if (cached && !refresh) {
      applyRoom(peer, cached.value, current);
      return Promise.resolve(cached);
    }
    if (peer.check?.sessionId === current.id) return peer.check.promise;
    const check = { sessionId: current.id };
    peer.check = check;
    check.promise = cache.get(peer.id, peer.playerId, current.id, current.now, lane, { refresh }).then((entry) => {
      const event = current.events[entry.value?.stage];
      if (peer.check === check && cache.peek(peer.id, current.id) === entry &&
          (!event || clock() < event.endsAt)) {
        applyRoom(peer, entry.value, current);
        return entry;
      }
    }).catch(() => {
      // A transient lookup failure skips this player for this round and retains its socket.
    }).finally(() => {
      if (peer.check === check) peer.check = undefined;
    });
    return check.promise;
  }

  async function persistPosition(peer, context, coordinates, now, sessionId) {
    const position = await positions.save(peer.playerId, coordinates, now, sessionId, undefined, { requireSharing: true });
    if (!position) return;
    if (position.session_id !== context.event.id || position.role !== context.role) {
      throw new GameError('INACTIVE', '当前未开启活动定位。');
    }
    return position;
  }

  function acceptPoint(peer, context, coordinates, updatedAt) {
    const point = {
      id: peer.id, member: peer.socket.id, instanceId, role: context.role,
      lat: coordinates.lat, lng: coordinates.lng,
      createdAt: peer.createdAt, updatedAt,
      expiresAt: Math.min(context.event.endsAt, updatedAt + positionLifetimeMs),
    };
    peer.point = point;
    void index.write(context.event, point, updatedAt);
    return point;
  }

  function queueIndex(playerId) {
    let hash = 0;
    for (let i = 0; i < playerId.length; i++) hash = (hash * 31 + playerId.charCodeAt(i)) | 0;
    return Math.abs(hash) % writeShards;
  }

  async function drainWriteQueue(shard) {
    if (!writeBehind || shard.writing) return;
    shard.writing = true;
    try {
      while (shard.jobs.length) {
        const job = shard.jobs[0];
        if (clock() >= job.context.event.endsAt) {
          shard.jobs.shift();
          writeQueueDrops++;
          continue;
        }
        try {
          await persistPosition(job.peer, job.context, job.coordinates, job.now, job.sessionId);
          shard.jobs.shift();
        } catch (error) {
          if (isTemporaryWriteError(error)) {
            writeQueueRetries++;
            await delay(200 + Math.floor(Math.random() * 151));
            continue;
          }
          // Permanent validation/session errors are dropped; the next accepted sample re-establishes state.
          shard.jobs.shift();
          writeQueueDrops++;
        }
      }
    } finally {
      shard.writing = false;
      if (shard.jobs.length) void drainWriteQueue(shard);
    }
  }

  async function updatePosition(peer, report) {
    await syncRoom(peer, scope());
    if (!isLatestReport(peer, report)) return;
    const { context } = peer;
    if (!context || clock() >= context.event.endsAt) throw new GameError('INACTIVE', '当前未开启活动定位。');
    const { payload } = report;
    const coordinates = checkedPosition(payload);
    if (Math.abs(coordinates.lat) > 85.05112878) throw new GameError('POSITION', '请提交有效的定位。', 400);
    const now = report.writeAt ??= clock();
    const sessionId = payload.sessionId ?? (context.registered ? context.event.id : undefined);
    if (!writeBehind) {
      const canRetry = () => isLatestReport(peer, report) && peer.context === context && clock() < context.event.endsAt;
      let backoff = !report.resent;
      let position;
      for (;;) {
        try {
          position = await positions.save(peer.playerId, coordinates, now, sessionId, undefined, { requireSharing: true });
          break;
        } catch (error) {
          if (!isTemporaryWriteError(error)) throw error;
          if (!canRetry()) return;
          if (!backoff) {
            report.resendAvailable = !report.resent && report.sampleId !== undefined;
            peer.socket.emit('live:error', positionUnavailable, {
              code: 'POSITION_RETRY_RETRYABLE', retryAfter: 1, sampleId: report.sampleId,
            });
            return;
          }
          backoff = false;
          await delay(150 + Math.floor(Math.random() * 151));
          if (!canRetry()) return;
        }
      }
      if (!peer.socket.connected || peer.generation !== report.generation || peer.context !== context ||
          clock() >= context.event.endsAt) return;
      if (position?.session_id !== context.event.id || position.role !== context.role) {
        throw new GameError('INACTIVE', '当前未开启活动定位。');
      }
      acceptPoint(peer, context, coordinates, position.updated_at ?? now);
      return;
    }

    const queue = writeQueues[queueIndex(peer.playerId)];
    if (queue.jobs.length >= maxWriteQueuePerShard) {
      writeQueueDrops++;
      peer.socket.emit('live:error', positionUnavailable, {
        code: 'POSITION_QUEUE_FULL', retryAfter: 1, sampleId: report.sampleId,
      });
      return;
    }
    acceptPoint(peer, context, coordinates, now);
    queue.jobs.push({ peer, context, coordinates, now, sessionId });
    void drainWriteQueue(queue);
  }

  const admissionStats = admitLiveConnections(io, async (req) => {
    const id = await game.authenticate(req);
    if (!id) return;
    const current = scope();
    return (await cache.get(publicId(id), id, current.id, current.now, 'handshake', { refresh: true })).value;
  });

  io.on('connection', (socket) => {
    const player = socket.data.player;
    const peer = {
      socket, playerId: player.id, id: publicId(player.id), createdAt: player.created_at,
      writing: false, generation: 0,
    };
    peers.set(socket.id, peer);
    socket.on('disconnecting', () => {
      // Keep the recoverable session ID. Current permissions determine every room on reconnect.
      for (const room of socket.rooms) socket.leave(room);
    });
    socket.on('disconnect', () => {
      discardReports(peer);
      clearPosition(peer);
      peers.delete(socket.id);
    });
    socket.on('live:position', (payload) => queuePosition(peer, payload));
    socket.on('live:clear-position', () => {
      discardReports(peer);
      clearPosition(peer);
    });
    void syncRoom(peer, scope(), 'handshake');
  });

  function invalidatePlayer(id, at) {
    cache.invalidate(id);
    invalidated.set(id, Math.max(at, invalidated.get(id) ?? 0));
    const current = scope();
    for (const peer of peers.values()) {
      if (peer.id !== id) continue;
      discardReports(peer);
      peer.check = undefined;
      clearPosition(peer);
      void syncRoom(peer, current);
    }
  }

  const invalidations = redis && openLiveInvalidations(redis, instanceId, invalidatePlayer, () => cache.invalidateAll());

  async function restoreGeo() {
    const run = ++recovery;
    const start = clock();
    const existing = [...peers.values()].filter(({ point }) => point?.expiresAt > start);
    let backoff = 35;
    for (let offset = 0; offset < existing.length; offset += 64) {
      if (stopped || !redis?.isReady || run !== recovery) return;
      const current = scope();
      const batch = existing.slice(offset, offset + 64);
      let restored = false;
      let checked = false;
      for (let attempt = 0; attempt < 3 && !restored; attempt++) {
        const checks = await Promise.all(batch.map((peer) => syncRoom(peer, current, 'recovery', true)));
        if (stopped || !redis?.isReady || run !== recovery) return;
        const now = clock();
        const newest = new Set(newestPositions([...peers.values()].flatMap(({ point }) => point ? [point] : [])));
        const active = [];
        for (const [offset, peer] of batch.entries()) {
          const point = peer.point;
          const entry = checks[offset];
          const player = entry?.value;
          const event = player?.sharing && current.events[player.stage];
          if (peer.socket.connected && point && newest.has(point) && entry === cache.peek(peer.id, current.id) &&
              event && peer.context?.event.id === event.id && player.role === point.role &&
              now < event.endsAt && point.expiresAt > now && point.updatedAt <= now &&
              point.updatedAt >= Math.max(event.startsAt, player.sharing_since ?? 0)) {
            active.push([event, point]);
          }
        }
        restored = await index.writeBatch(active, now);
        checked = batch.every((peer, offset) => !peer.socket.connected || !peer.point || !!checks[offset]);
        if (!restored || !checked) {
          restored = false;
          if (attempt < 2) {
            await delay(backoff + Math.floor(Math.random() * 45));
            backoff = Math.min(backoff * 2, 1000);
          }
        }
      }
      backoff = restored && checked ? 35 : Math.min(backoff * 2, 1000);
      if (offset + 64 < existing.length) await delay(backoff + Math.floor(Math.random() * 45));
    }
  }
  function redisReady() {
    // A Redis restart may leave pre-outage GEO entries behind if persistence is enabled.
    redisIndexedSince = Date.now();
    void restoreGeo().catch(() => console.warn('实时位置索引恢复失败，等待后续上报。'));
  }
  redis?.on('ready', redisReady);

  async function sendSnapshots() {
    cache.prune();
    if (sending || !peers.size) return;
    sending = true;
    try {
      const current = scope();
      const rooms = new Map();
      const local = new Map();
      const snapshotPeers = [...peers.values()];
      const pending = [];
      for (const peer of snapshotPeers) {
        if (peer.latestReport?.resendAvailable && current.now >= peer.latestReport.receivedAt + positionLifetimeMs) {
          peer.latestReport = undefined;
        }
        const cached = cache.peek(peer.id, current.id);
        if (cached) {
          try { applyRoom(peer, cached.value, current); } catch { continue; }
        }
        else pending.push(syncRoom(peer, current));
      }
      if (pending.length) await Promise.race([Promise.all(pending), delay(150)]);
      for (const peer of snapshotPeers) {
        if (!peer.socket.connected || !peer.context || !cache.peek(peer.id, current.id)) continue;
        try {
          if (peer.point?.expiresAt <= current.now) clearPosition(peer);
          const { room, event, role } = peer.context;
          if (peer.point) {
            const key = `${event.id}:${role}`;
            if (!local.has(key)) local.set(key, []);
            local.get(key).push(peer.point);
          }
          let group = rooms.get(room);
          if (!group) {
            group = { peer, recipients: [] };
            rooms.set(room, group);
          } else if ((peer.point?.updatedAt ?? -1) > (group.peer.point?.updatedAt ?? -1)) {
            group.peer = peer;
          }
          group.recipients.push(peer);
        } catch {
          // A malformed peer only drops out of this snapshot.
        }
      }
      const sources = new Map();
      const groups = [...rooms.values()];
      for (let offset = 0; offset < groups.length; offset += 6) {
        await Promise.all(groups.slice(offset, offset + 6).map(async ({ peer, recipients }) => {
          try {
            const context = peer.context;
            if (!context) return;
            const { event, role, room } = context;
            const targetRole = role === 'cat' ? 'mouse' : 'cat';
            const origin = role === 'mouse' ? peer.point : undefined;
            const key = `${event.id}:${targetRole}`;
            if (!sources.has(key)) sources.set(key, index.read(event, targetRole));
            const remote = await sources.get(key);
            const now = clock();
            if (peer.context !== context || !peer.socket.connected || now >= event.endsAt ||
                !cache.peek(peer.id, current.id)) return;
            const candidates = remote.filter((point) => point.instanceId !== instanceId &&
              (point.indexedAt ?? -Infinity) >= redisIndexedSince &&
              point.updatedAt > (invalidated.get(point.id) ?? -Infinity));
            for (const point of local.get(key) ?? []) {
              if (peers.get(point.member)?.point === point) candidates.push(point);
            }
            const fresh = newestPositions(candidates.filter((point) => point.expiresAt > now && point.id !== peer.id));
            let visible = [];
            if (role === 'cat') {
              visible = fresh.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, mouseLimit);
            } else if (origin && origin.expiresAt > now && peer.point === origin) {
              visible = fresh.filter((point) => isNearby(origin, point));
            }
            const markers = visible.map(({ id, lat, lng, role, expiresAt }) => ({ id, lat, lng, role, expiresAt }));
            for (const recipient of recipients) {
              if (recipient.socket.connected && recipient.context?.room === room && cache.peek(recipient.id, current.id)) {
                recipient.socket.volatile.emit('live:positions', event.id, markers);
              }
            }
          } catch {
            // A room lookup or serialization failure only drops this room's snapshot.
          }
        }));
      }
    } finally {
      sending = false;
    }
  }

  const timer = setInterval(() => {
    const cutoff = clock() - positionLifetimeMs;
    for (const [id, at] of invalidated) if (at < cutoff) invalidated.delete(id);
    void sendSnapshots().catch(() => console.warn('实时位置推送暂时不可用。'));
  }, snapshotIntervalMs);
  timer.unref();
  // Refresh the Socket.IO recovery offset without storing or replaying coordinates.
  const heartbeat = setInterval(() => { if (peers.size) io.emit('live:heartbeat'); }, 30_000);
  heartbeat.unref();
  httpServer.once('close', () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    redis?.off('ready', redisReady);
    invalidations?.close();
  });
  return {
    io, admissionStats,
    positionQueueStats: () => ({
      queued: writeQueues.reduce((sum, queue) => sum + queue.jobs.length, 0),
      writing: writeQueues.filter((queue) => queue.writing).length,
      drops: writeQueueDrops, retries: writeQueueRetries,
    }),
    profileChanged(playerId) {
      const id = publicId(playerId);
      const at = clock();
      invalidatePlayer(id, at);
      void invalidations?.publish(id, at);
    },
  };
}
