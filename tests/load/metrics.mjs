import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const cadence = 5000;
export const mouseCount = 10;
export const latBase = 34.1791;
export const playerId = (index) => `load-${String(index).padStart(27, '0')}`;
export const roleOf = (index) => index < mouseCount ? 'mouse' : 'cat';
export const sampleTime = (lat, epoch) => epoch + Math.round((lat - latBase) * 1e9);
export const positionSampleKey = (id, at) => `${id}:${at}`;

export function position(index, at, epoch, sessionId) {
  return { lat: latBase + (at - epoch) / 1e9, lng: 108.9181 + (index % 41) * 0.00001, accuracy: 10, sessionId };
}

export function inWindow(phase, at) {
  return phase && at >= phase.start && at < phase.end;
}

export function increment(counts, key, value = 1) {
  counts[key] = (counts[key] ?? 0) + value;
}

export function observe(histogram, ms) {
  increment(histogram, Math.max(0, Math.round(ms)));
}

export function distribution(histogram) {
  const entries = Object.entries(histogram).sort(([a], [b]) => Number(a) - Number(b));
  const count = entries.reduce((total, [, hits]) => total + hits, 0);
  function percentile(fraction) {
    let remaining = Math.ceil(count * fraction);
    for (const [ms, hits] of entries) {
      remaining -= hits;
      if (remaining <= 0) return Number(ms);
    }
    return null;
  }
  return { count, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) };
}

export function mergeCounts(groups) {
  const combined = {};
  for (const group of groups) {
    for (const [key, count] of Object.entries(group)) increment(combined, key, count);
  }
  return combined;
}

export function processSampler() {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let previous = process.cpuUsage();
  let timestamp = performance.now();
  let utilization = performance.eventLoopUtilization();
  return () => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const loop = performance.eventLoopUtilization();
    const sample = {
      at: Date.now(),
      cpuPctOfCore: Math.round((cpu.user + cpu.system - previous.user - previous.system) / (10 * (now - timestamp))),
      loopPct: Math.round(performance.eventLoopUtilization(loop, utilization).utilization * 100),
      loopP99Ms: Math.round(delay.percentile(99) / 1e6),
      rssMiB: Math.round(process.memoryUsage.rss() / 2 ** 20),
    };
    previous = cpu;
    timestamp = now;
    utilization = loop;
    delay.reset();
    return sample;
  };
}

export function listenForCommands(commands) {
  process.on('message', async ({ id, command, ...args }) => {
    try {
      const result = await commands[command](args);
      process.send({ id, result });
    } catch (error) {
      process.send({ id, error: error.message });
    }
  });
  process.on('disconnect', () => process.exit(0));
}
