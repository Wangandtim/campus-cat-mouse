import { eventDate, sessionWindow } from './rules.mjs';

function nextClosingTime(now) {
  const today = eventDate(now);
  for (const stage of ['morning', 'evening']) {
    const { endsAt } = sessionWindow(today, stage);
    if (endsAt > now) return endsAt;
  }
  return sessionWindow(eventDate(now + 86_400_000), 'morning').endsAt;
}

export function scheduleSettlements(settleDue, {
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = (error) => console.error('场次结算失败，稍后补算。', error.code ?? error.name),
} = {}) {
  let stopped = false;
  let timer;
  let pending;

  async function scan() {
    const startedAt = clock();
    let next = nextClosingTime(startedAt);
    try {
      await settleDue(startedAt);
    } catch (error) {
      onError(error);
      next = Math.min(next, clock() + 30_000);
    }
    if (!stopped) {
      timer = setTimer(run, Math.max(0, next - clock()));
      timer?.unref?.();
    }
  }

  function run() {
    pending = scan();
    return pending;
  }

  return {
    ready: run(),
    async stop() {
      stopped = true;
      clearTimer(timer);
      await pending;
    },
  };
}
