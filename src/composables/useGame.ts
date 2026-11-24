import { computed, onMounted, onUnmounted, provide, ref, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { ApiError, campus, metersBetween, request, type GameState, type Position, type Profile, type Role, type StageId, type ZoneView } from '../model';
import { liveConnectionOptions } from './liveConnection';

type LiveMarker = { id: string; lat: number; lng: number; role: Role; expiresAt: number };
type LiveRoom = { eventId: string | null; endsAt: number; role: Role };
type Coordinates = { lat: number; lng: number; accuracy: number; sessionId?: string };
type LivePosition = Coordinates & { sampleId: number; sampledAt: number };
type LiveErrorDetail = { code?: string; retryAfter?: number; sampleId?: number };
type GapReason = 'hidden' | 'gps';
type LiveEvents = {
  disconnect: () => void;
  connect_error: () => void;
  'live:ready': (room: LiveRoom) => void;
  'live:positions': (eventId: string, markers: LiveMarker[]) => void;
  'live:error': (message: string, detail?: LiveErrorDetail) => void;
};
type LiveSocket = {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  on<Event extends keyof LiveEvents>(event: Event, callback: LiveEvents[Event]): void;
  emit(event: 'live:clear-position'): void;
  volatile: { emit(event: 'live:position', point: LivePosition): void };
};

const liveClientUrl = '/socket.io/socket.io.esm.min.js';
const positionLifetimeMs = 15_000;
export const liveMapKey: InjectionKey<{
  enabled: Ref<boolean>;
  canShare: ComputedRef<boolean>;
  markers: ComputedRef<LiveMarker[]>;
  message: Ref<string>;
  gpsPosition: Ref<Position | undefined>;
  setOpen(open: boolean): void;
  enableLocation(position: GeolocationPosition): void;
}> = Symbol('live map');

export function useGame(allowed: Readonly<Ref<boolean>>) {
  const state = ref<GameState | null>(null);
  const issue = ref('');
  const positionIssue = ref('');
  const busy = ref(false);
  const now = ref(Date.now());
  const selectedId = ref('central');
  const mapPosition = ref<Position>(campus.demoPosition);
  let clockTimer = 0;
  let refreshTimer = 0;
  let requestVersion = 0;
  let clockOffset = 0;
  let lastRefreshAt = 0;

  const liveEnabled = ref(false);
  const mapOpen = ref(false);
  const foreground = ref(!document.hidden);
  const liveRoom = shallowRef<LiveRoom>();
  const liveMarkers = shallowRef<LiveMarker[]>([]);
  const liveMessage = ref('');
  const gpsPosition = shallowRef<Position>();
  const mapLocationEnabled = ref(false);
  const stopping = ref(false);
  let pendingReading: GeolocationPosition | undefined;
  let lastReportedAt = -Infinity;
  let lastSampleAt = -Infinity;
  let posting = false;
  let pendingGap: { sessionId: string; reason: GapReason } | undefined;
  let liveSocket: LiveSocket | undefined;
  let nextSampleId = 0;
  let latestLiveSample: LivePosition | undefined;
  let reconnectSample: LivePosition | undefined;
  let positionRetryTimer: number | undefined;
  const playerScope = computed(() => {
    const game = state.value;
    return game && `${game.stage.id}:${game.profile.role}:${game.profile.sharing}`;
  });
  const canShare = computed(() => {
    const room = liveRoom.value;
    const game = state.value;
    return !!(foreground.value && mapOpen.value && room?.eventId?.endsWith(`:${game?.stage.id}`) &&
      room.role === game?.profile.role && game.profile.sharing && room.endsAt > now.value);
  });
  const visibleMarkers = computed(() => canShare.value ? liveMarkers.value : []);
  const trackingId = computed(() => {
    const game = state.value;
    return game?.stats.tracking && game.participation?.open && game.stage.endsAt > now.value && !stopping.value
      ? game.participation.sessionId : undefined;
  });
  const wantsLocation = computed(() => allowed.value && foreground.value &&
    (!!trackingId.value || (canShare.value && mapLocationEnabled.value)));
  watch(trackingId, () => { positionIssue.value = ''; });

  function cancelPositionRetry() {
    window.clearTimeout(positionRetryTimer);
    positionRetryTimer = undefined;
    latestLiveSample = undefined;
  }

  function retryPosition(socket: LiveSocket, detail?: LiveErrorDetail) {
    const sample = latestLiveSample;
    const retryAfter = detail?.retryAfter;
    // Socket.IO error details express retryAfter in seconds.
    if (!sample || positionRetryTimer !== undefined || detail?.code !== 'POSITION_RETRY_RETRYABLE' ||
        detail.sampleId !== sample.sampleId || typeof retryAfter !== 'number' ||
        !Number.isFinite(retryAfter) || retryAfter <= 0 || retryAfter * 1000 > positionLifetimeMs || liveSocket !== socket) return;
    positionRetryTimer = window.setTimeout(() => {
      if (latestLiveSample !== sample) return;
      cancelPositionRetry();
      const status = state.value?.participation?.status;
      if (!wantsLocation.value || !canShare.value || document.hidden || stopping.value || busy.value ||
          status === 'paused' || status === 'exited' || liveSocket !== socket || !socket.connected ||
          Date.now() - sample.sampledAt > positionLifetimeMs) return;
      socket.volatile.emit('live:position', sample);
    }, retryAfter * 1000);
  }

  function visibilityChanged() {
    if (document.hidden) pageHidden();
    else if (!foreground.value) {
      foreground.value = true;
      if (allowed.value && !busy.value) void refresh(true);
    }
  }

  function pageHidden() {
    if (foreground.value) flagGap('hidden');
    foreground.value = false;
  }

  function flagGap(reason: GapReason) {
    cancelPositionRetry();
    if (liveSocket?.connected) liveSocket.emit('live:clear-position');
    pendingReading = undefined;
    const sessionId = trackingId.value;
    if (!sessionId || pendingGap?.sessionId === sessionId) return;
    pendingGap = { sessionId, reason };
    // The next live sample also carries the gap if the WebView suspends this request.
    void fetch('/api/preview/tracking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'gap', sessionId, reason }), keepalive: true,
    }).catch(() => undefined);
  }

  watch([liveEnabled, mapOpen, foreground, playerScope], async ([enabled, open, visible, scope], _, onCleanup) => {
    if (!enabled || !open || !visible || !scope) return;
    let stopped = false;
    onCleanup(() => {
      stopped = true;
      cancelPositionRetry();
      reconnectSample = undefined;
      liveSocket?.disconnect();
      liveSocket = undefined;
      liveRoom.value = undefined;
      liveMarkers.value = [];
      liveMessage.value = '';
    });

    try {
      const { io } = await import(/* @vite-ignore */ liveClientUrl) as {
        io(options: ReturnType<typeof liveConnectionOptions>): LiveSocket;
      };
      if (stopped) return;
      const socket = io(liveConnectionOptions());
      liveSocket = socket;
      socket.on('live:ready', (room) => {
        cancelPositionRetry();
        liveRoom.value = room;
        liveMarkers.value = [];
        liveMessage.value = '';
        const sample = reconnectSample;
        reconnectSample = undefined;
        if (!sample || !canShare.value || !socket.connected || Date.now() - sample.sampledAt > positionLifetimeMs) return;
        if (sample.sessionId && sample.sessionId !== trackingId.value) return;
        const resumed = { ...sample, sampleId: ++nextSampleId, sampledAt: Date.now() };
        latestLiveSample = resumed;
        socket.volatile.emit('live:position', resumed);
      });
      socket.on('live:positions', (eventId, markers) => {
        if (canShare.value && liveRoom.value?.eventId === eventId) {
          liveMarkers.value = markers.filter(({ expiresAt }) => expiresAt > now.value);
        }
      });
      socket.on('live:error', (message, detail) => {
        liveMessage.value = message;
        retryPosition(socket, detail);
      });
      socket.on('connect_error', () => { liveMessage.value = '实时位置暂未连接。'; });
      socket.on('disconnect', () => {
        if (latestLiveSample) reconnectSample = latestLiveSample;
        cancelPositionRetry();
        liveRoom.value = undefined;
        liveMarkers.value = [];
        if (!stopped) liveMessage.value = '实时位置已断开，正在重连。';
      });
      socket.connect();
    } catch {
      if (!stopped) liveMessage.value = '实时位置暂不可用。';
    }
  });

  function acceptLocation(position: GeolocationPosition) {
    if (latestLiveSample && Math.trunc(position.timestamp) > latestLiveSample.sampledAt) cancelPositionRetry();
    const point: Position = [position.coords.longitude, position.coords.latitude];
    if (metersBetween(point, campus.center) <= 1300) gpsPosition.value = point;
    pendingReading = position;
    void reportLocation();
  }

  async function reportLocation() {
    const reading = pendingReading;
    const wallTime = Date.now();
    if (!wantsLocation.value || !reading || posting || wallTime - lastReportedAt < 5000) return;
    pendingReading = undefined;
    if (reading.timestamp <= lastSampleAt || wallTime - reading.timestamp > positionLifetimeMs) return;
    cancelPositionRetry();
    const { latitude: lat, longitude: lng, accuracy } = reading.coords;
    const sessionId = trackingId.value;
    const gap = pendingGap?.sessionId === sessionId ? pendingGap : undefined;
    const nearby = metersBetween([lng, lat], campus.center) <= 1300;
    lastReportedAt = wallTime;
    lastSampleAt = reading.timestamp;
    if (!nearby && liveSocket?.connected) liveSocket.emit('live:clear-position');
    if (!gap && nearby && canShare.value && liveSocket?.connected) {
      const point = { lat, lng, accuracy, sessionId, sampleId: ++nextSampleId, sampledAt: Math.trunc(reading.timestamp) };
      latestLiveSample = point;
      liveSocket.volatile.emit('live:position', point);
    } else if (sessionId) {
      posting = true;
      try {
        await request('/api/preview/position', { lat, lng, accuracy, sessionId, gap: gap?.reason });
        if (gap === pendingGap) pendingGap = undefined;
        positionIssue.value = '';
      } catch (error) {
        if (trackingId.value === sessionId && foreground.value) {
          if (error instanceof ApiError && error.status === 503) positionIssue.value = error.message;
          flagGap('gps');
        }
      } finally {
        posting = false;
      }
    }
  }

  watch(wantsLocation, (enabled, _, onCleanup) => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      flagGap('gps');
      return;
    }
    let watching = true;
    const id = navigator.geolocation.watchPosition((position) => {
      if (watching && wantsLocation.value) acceptLocation(position);
    }, () => {
      if (watching && wantsLocation.value) flagGap('gps');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 });
    onCleanup(() => {
      watching = false;
      pendingReading = undefined;
      navigator.geolocation.clearWatch(id);
    });
  });
  watch(trackingId, (id) => {
    cancelPositionRetry();
    if (!id || id !== pendingGap?.sessionId) pendingGap = undefined;
    pendingReading = undefined;
  });

  provide(liveMapKey, {
    enabled: liveEnabled,
    canShare,
    markers: visibleMarkers,
    message: liveMessage,
    gpsPosition,
    setOpen: (open) => { mapOpen.value = open; },
    enableLocation(position) {
      mapLocationEnabled.value = true;
      acceptLocation(position);
    },
  });

  const zoneViews = computed<ZoneView[]>(() => campus.zones.map((zone) => ({
    ...zone,
    distance: metersBetween(mapPosition.value, zone.position),
    available: zone.mice.filter((mouseId) => !state.value?.captures.some((item) => item.mouseId === mouseId)),
    cooldown: Math.max(0, Math.ceil(((state.value?.cooldowns.find((item) => item.zoneId === zone.id)?.until ?? 0) - now.value) / 1000)),
  })).sort((a, b) => a.distance - b.distance));
  const selectedZone = computed(() => zoneViews.value.find(({ id }) => id === selectedId.value) ?? zoneViews.value[0]);

  function apply(data: GameState) {
    clockOffset = data.serverTime - Date.now();
    now.value = Date.now() + clockOffset;
    state.value = data;
    issue.value = '';
  }

  async function refresh(quiet = false) {
    if (!allowed.value) return;
    const version = ++requestVersion;
    lastRefreshAt = Date.now();
    try {
      const data = await request<GameState & { livePositions?: boolean }>('/api/preview/state');
      if (version === requestVersion && allowed.value) {
        liveEnabled.value = !!data.livePositions;
        apply(data);
      }
    } catch (error) {
      if (!quiet && version === requestVersion) issue.value = (error as Error).message;
    }
  }

  async function mutate(path: string, payload: object, responseIsState = true, id?: string) {
    if (busy.value) return;
    busy.value = true;
    ++requestVersion;
    try {
      if (responseIsState) apply(await request<GameState>(path, payload));
      else {
        await request(path, payload, id);
        await refresh();
      }
    } catch (error) {
      issue.value = (error as Error).message;
    } finally {
      busy.value = false;
    }
  }

  function changeProfile(profile: Partial<Profile & { stage: StageId }>) {
    if (profile.sharing === false || profile.stage || profile.role) cancelPositionRetry();
    return mutate('/api/preview/profile', profile);
  }

  async function track(active: boolean) {
    if (busy.value) return;
    if (!active) cancelPositionRetry();
    stopping.value = !active;
    try {
      await mutate('/api/preview/tracking', { active, sessionId: state.value?.participation?.sessionId });
    } finally {
      stopping.value = false;
    }
  }

  async function exitParticipation() {
    if (busy.value || !state.value?.participation) return;
    cancelPositionRetry();
    stopping.value = true;
    try {
      await mutate('/api/preview/tracking', { action: 'exit', sessionId: state.value.participation.sessionId });
    } finally {
      stopping.value = false;
    }
  }

  let pendingWalk: string | undefined;
  async function walk() {
    if (busy.value) return;
    pendingWalk ??= crypto.randomUUID();
    await mutate('/api/preview/move', {}, false, pendingWalk);
    if (!issue.value) pendingWalk = undefined;
  }

  watch(allowed, (enabled) => {
    if (enabled) void refresh();
    else {
      ++requestVersion;
      state.value = null;
      liveEnabled.value = false;
      mapLocationEnabled.value = false;
      gpsPosition.value = undefined;
    }
  });
  onMounted(() => {
    if (allowed.value) void refresh();
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('pagehide', pageHidden);
    window.addEventListener('pageshow', visibilityChanged);
    clockTimer = window.setInterval(() => {
      now.value = Date.now() + clockOffset;
      void reportLocation();
      if (liveMarkers.value.some(({ expiresAt }) => expiresAt <= now.value)) {
        liveMarkers.value = liveMarkers.value.filter(({ expiresAt }) => expiresAt > now.value);
      }
    }, 1000);
    refreshTimer = window.setInterval(() => {
      if (busy.value || document.hidden || !state.value) return;
      const { role, sharing } = state.value.profile;
      const interval = role === 'mouse' && sharing ? 1000 : 5000;
      if (Date.now() - lastRefreshAt >= interval) void refresh(true);
    }, 1000);
  });
  onUnmounted(() => {
    document.removeEventListener('visibilitychange', visibilityChanged);
    window.removeEventListener('pagehide', pageHidden);
    window.removeEventListener('pageshow', visibilityChanged);
    window.clearInterval(clockTimer);
    window.clearInterval(refreshTimer);
  });

  return { state, issue, positionIssue, busy, now, zoneViews, selectedId, selectedZone, mapPosition, refresh, changeProfile,
    track, exitParticipation, walk };
}
