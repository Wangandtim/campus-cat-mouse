import { SharedArray } from 'k6/data';
import { vu } from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';

const cookies = new SharedArray('synthetic test sessions', () => JSON.parse(open(__ENV.LOAD_COOKIES)));
const port = Number(__ENV.LOAD_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a loopback fixture port');
const seconds = Number(__ENV.LOAD_SECONDS);
const epoch = Number(__ENV.LOAD_EPOCH);
const sessionId = __ENV.LOAD_SESSION;
const latBase = 34.1791;
export const options = {
  scenarios: { cold: { executor: 'per-vu-iterations', vus: cookies.length, iterations: 1,
    maxDuration: `${seconds + 10}s`, gracefulStop: '3s' } },
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

const dials = new Counter('load_dials');
const ready = new Counter('load_rooms_ready');
const sessions = new Counter('load_namespaces');
const upgrades = new Counter('load_transport_upgrades');
const handshake = new Trend('load_namespace_ms', true);
const errors = new Counter('load_errors');
const errorCounts = Object.fromEntries(['websocket', 'namespace', 'live', 'upgrade', 'dial']
  .map((kind) => [kind, new Counter(`load_error_${kind}`)]));
const sends = new Counter('load_positions_sent');
const snapshots = new Counter('load_snapshots');
const unexpectedCloses = new Counter('load_unexpected_closes');
const visibility = new Trend('load_visible_ms', true);

function recordError(kind) {
  errors.add(1);
  errorCounts[kind].add(1);
}

export default function () {
  const index = vu.idInTest - 1;
  const start = Date.now();
  const seen = {};
  let done = false;
  dials.add(1);
  try {
    const response = ws.connect(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
      headers: { 'X-Forwarded-Proto': 'https', Cookie: cookies[index] },
    }, (socket) => {
      socket.on('error', () => recordError('websocket'));
      socket.on('close', () => { if (!done) unexpectedCloses.add(1); });
      socket.setTimeout(() => { done = true; socket.close(); }, seconds * 1000);
      socket.on('message', (packet) => {
        if (packet[0] === '0') socket.send('40');
        else if (packet[0] === '2') socket.send('3' + packet.slice(1));
        else if (packet.startsWith('40')) {
          sessions.add(1);
          handshake.add(Date.now() - start);
        } else if (packet.startsWith('44')) {
          recordError('namespace');
          done = true;
          socket.close();
        } else if (packet.startsWith('42')) {
          const [event, data, markers] = JSON.parse(packet.slice(2));
          if (event === 'live:ready' && data.eventId === sessionId) {
            ready.add(1);
            function send() {
              const lat = latBase + (Date.now() - epoch) / 1e9;
              const lng = 108.9181 + (index % 41) * 0.00001;
              socket.send('42' + JSON.stringify(['live:position', { lat, lng, accuracy: 10, sessionId }]));
              sends.add(1);
            }
            socket.setTimeout(() => {
              send();
              socket.setInterval(send, 5000);
            }, Math.max(1, index * 107 % 5000));
          } else if (event === 'live:positions' && data === sessionId) {
            snapshots.add(1);
            const now = Date.now();
            for (const marker of markers) {
              const at = epoch + Math.round((marker.lat - latBase) * 1e9);
              if (at > (seen[marker.id] || 0)) {
                seen[marker.id] = at;
                visibility.add(now - at);
              }
            }
          } else if (event === 'live:error') recordError('live');
        }
      });
    });
    if (response?.status === 101) upgrades.add(1);
    else recordError('upgrade');
  } catch {
    recordError('dial');
  }
}
