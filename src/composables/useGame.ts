import { computed, onMounted, onUnmounted, ref } from 'vue';
import { campus, metersBetween, request, type GameState, type Position, type Profile, type StageId, type ZoneView } from '../model';

export function useGame() {
  const state = ref<GameState | null>(null);
  const issue = ref('');
  const busy = ref(false);
  const now = ref(Date.now());
  const selectedId = ref('central');
  const mapPosition = ref<Position>(campus.demoPosition);
  let clockTimer = 0;
  let refreshTimer = 0;
  let requestVersion = 0;
  let clockOffset = 0;
  let lastRefreshAt = 0;

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
    const version = ++requestVersion;
    lastRefreshAt = Date.now();
    try {
      const data = await request<GameState>('/api/preview/state');
      if (version === requestVersion) apply(data);
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
    return mutate('/api/preview/profile', profile);
  }

  function track(active: boolean) {
    return mutate('/api/preview/tracking', { active });
  }

  let pendingWalk: string | undefined;
  async function walk() {
    if (busy.value) return;
    pendingWalk ??= crypto.randomUUID();
    await mutate('/api/preview/move', {}, false, pendingWalk);
    if (!issue.value) pendingWalk = undefined;
  }

  onMounted(() => {
    void refresh();
    clockTimer = window.setInterval(() => { now.value = Date.now() + clockOffset; }, 1000);
    refreshTimer = window.setInterval(() => {
      if (busy.value || document.hidden || !state.value) return;
      const { role, sharing } = state.value.profile;
      const interval = role === 'mouse' && sharing ? 1000 : 5000;
      if (Date.now() - lastRefreshAt >= interval) void refresh(true);
    }, 1000);
  });
  onUnmounted(() => {
    window.clearInterval(clockTimer);
    window.clearInterval(refreshTimer);
  });

  return { state, issue, busy, now, zoneViews, selectedId, selectedZone, mapPosition, refresh, changeProfile, track, walk };
}
