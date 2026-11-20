import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { test } from 'node:test';
import { admitLiveConnections } from './admission.mjs';

test('returns 503 with Retry-After on both transports and preserves admitted connections',
  { timeout: 5000 }, async (t) => {
    const server = createServer();
    const io = new Server(server);
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const admissionStats = admitLiveConnections(io, async (req) => {
      if (req.url.includes('&hold=1')) {
        entered.resolve();
        await resume.promise;
      }
      return { id: 'synthetic-player' };
    }, { maxPending: 1, retryAfter: 2 });
    let existing;
    t.after(async () => { resume.resolve(); existing?.disconnect(); await io.close(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    existing = connect(base, { transports: ['websocket'] });
    await once(existing, 'connect');
    const endpoint = `${base}/socket.io/?EIO=4`;
    const first = fetch(`${endpoint}&transport=polling&hold=1`);
    await entered.promise;
    const rejected = await fetch(`${endpoint}&transport=polling`);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('retry-after'), '2');
    const rejectedUpgrade = await new Promise((resolve, reject) => {
      get(`${endpoint}&transport=websocket`, { headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      } }, (response) => {
        response.resume();
        resolve(response);
      }).on('error', reject);
    });
    assert.equal(rejectedUpgrade.statusCode, 503);
    assert.equal(rejectedUpgrade.headers['retry-after'], '2');
    assert.equal(admissionStats().pending, 1);
    assert.equal(admissionStats().busy, 2);
    assert.equal(existing.connected, true);

    resume.resolve();
    const accepted = await first;
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /^0\{/);
    assert.equal(admissionStats().peakPending, 1);
    assert.equal(admissionStats().accepted, 2);
  });
