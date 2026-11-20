import { limits } from '../rules.mjs';

export const exportRetentionMs = 60 * 60_000;
export const positionRetentionMs = 2 * limits.positionAge;
export const positionSweepMs = 30_000;
const maxDurationSeconds = Math.floor(0x7fffffff / 1000);

function duration(env, name, fallback, minSeconds = 1) {
  const configured = env[name]?.trim();
  if (!configured) return fallback;
  const seconds = Number(configured);
  if (!/^\d+$/.test(configured) || seconds < minSeconds || seconds > maxDurationSeconds) {
    throw new Error(`${name} 必须为 ${minSeconds} 到 ${maxDurationSeconds} 的整数秒。`);
  }
  return seconds * 1000;
}

export function retentionSettings(env) {
  return {
    exportRetentionMs: duration(env, 'CAMPUS_EXPORT_RETENTION_SECONDS', exportRetentionMs),
    positionRetentionMs: duration(env, 'CAMPUS_POSITION_RETENTION_SECONDS', positionRetentionMs,
      Math.floor(limits.positionAge / 1000) + 1),
    positionSweepMs: duration(env, 'CAMPUS_POSITION_SWEEP_SECONDS', positionSweepMs),
  };
}
