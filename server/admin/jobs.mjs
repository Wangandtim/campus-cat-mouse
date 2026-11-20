import { eventDate } from '../rules.mjs';
import { publishesAt, shiftDay, startsAt } from './common.mjs';

export function scheduleAdminJobs(admin, clock = Date.now) {
  let timer;
  let stopped = false;
  let pending;

  function run() {
    pending = admin.runJobs((day) => console.warn(`教师邀约 ${day} 等待早晚场结算。`))
      .catch((error) => console.error('教师邀约或任命任务失败，稍后重试。', error.code ?? error.name))
      .finally(() => {
        if (stopped) return;
        const now = clock();
        const today = eventDate(now);
        const boundaries = [startsAt(today), publishesAt(today), startsAt(shiftDay(today, 1)), now + 30_000];
        const next = Math.min(...boundaries.filter((time) => time > now));
        timer = setTimeout(run, next - now);
        timer.unref();
      });
  }

  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
