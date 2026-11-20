import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import ts from 'typescript';
import { createRenderer, h, inject, ref } from 'vue';
import campus from '../data/campus.json' with { type: 'json' };

const gameModule = new URL('./useGame.ts', import.meta.url).href;
const modelModule = new URL('../model.ts', import.meta.url).href;
const fakeSocketModule = 'data:text/javascript,' + encodeURIComponent('export const io = () => globalThis.makeTestLiveSocket();');
// Resolve Vite's extensionless imports and replace the browser-served Socket.IO bundle.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === gameModule) {
      if (specifier === '/socket.io/socket.io.esm.min.js') return next(fakeSocketModule, context);
      if (specifier === '../model' || specifier === './liveConnection') return next(`${specifier}.ts`, context);
    }
    if (context.parentURL === modelModule && specifier === './data/campus.json') {
      return { ...next(specifier, context), importAttributes: { type: 'json' } };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== modelModule) return next(url, context);
    // ApiError uses a TypeScript parameter property, which needs transpiling in Node.
    const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return { format: 'module', source, shortCircuit: true };
  },
});
after(() => hooks.deregister());
const { liveMapKey, useGame } = await import(gameModule);

async function liveMap(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.UTC(2026, 10, 22, 23) });
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const connected = Promise.withResolvers();
  const reports = [];
  const endsAt = Date.now() + 30 * 60_000;
  let stage = 'morning';
  let status = 'active';
  const sessionId = () => `2026-11-23:${stage}`;
  const globals = {
    window, document, navigator: { geolocation: { watchPosition: () => 1, clearWatch() {} } },
    makeTestLiveSocket() {
      const socket = new EventEmitter();
      socket.volatile = { emit: (event, point) => { if (event === 'live:position') reports.push(point); } };
      socket.connect = () => {
        socket.connected = true;
        socket.emit('live:ready', { eventId: sessionId(), endsAt, role: 'cat' });
        connected.resolve(socket);
      };
      socket.disconnect = () => {
        if (!socket.connected) return;
        socket.connected = false;
        socket.emit('disconnect');
      };
      return socket;
    },
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  let app;
  t.after(() => {
    app?.unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    if (path.endsWith('/profile') && body.stage) stage = body.stage;
    if (path.endsWith('/tracking') && body.active === false) status = 'paused';
    if (path.endsWith('/tracking') && body.action === 'exit') status = 'exited';
    return { ok: true, json: async () => ({
      livePositions: true, serverTime: Date.now(), profile: { nickname: 'test', role: 'cat', sharing: true },
      stage: { id: stage, endsAt }, stats: { tracking: status === 'active' },
      participation: { sessionId: sessionId(), open: true, status }, captures: [], cooldowns: [],
    }) };
  });

  let game;
  let map;
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {} });
  app = renderer.createApp({
    setup() {
      game = useGame(ref(true));
      const Map = { setup() { map = inject(liveMapKey); return () => null; } };
      return () => h(Map);
    },
  });
  app.mount({});
  map.setOpen(true);
  const socket = await connected.promise;
  const fix = (offset = 0) => map.enableLocation({
    timestamp: Date.now(), coords: { longitude: campus.center[0] + offset, latitude: campus.center[1], accuracy: 10 },
  });
  function retryHint(sampleId = reports[0].sampleId) {
    socket.emit('live:error', '活动定位暂不可用。', { code: 'POSITION_RETRY_RETRYABLE', retryAfter: 0.2, sampleId });
  }
  return { socket, game, document, reports, fix, retryHint };
}

test('resends a position with the original sample ID and timestamp at most once', { timeout: 5000 }, async (t) => {
  const { reports, fix, retryHint } = await liveMap(t);
  fix();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].sampleId > 0);
  retryHint();
  retryHint();
  t.mock.timers.tick(199);
  assert.equal(reports.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(reports, [reports[0], reports[0]]);
  retryHint();
  t.mock.timers.tick(200);
  assert.equal(reports.length, 2);
});

test('a newer GPS fix cancels the old resend before the normal reporting interval', { timeout: 5000 }, async (t) => {
  const { reports, fix, retryHint } = await liveMap(t);
  fix();
  retryHint();
  t.mock.timers.tick(10);
  fix(0.00001);
  t.mock.timers.tick(190);
  assert.equal(reports.length, 1);
  t.mock.timers.tick(4800);
  assert.equal(reports.length, 2);
  assert.ok(reports[1].sampleId > reports[0].sampleId);
  assert.equal(reports[1].lng, campus.center[0] + 0.00001);
  retryHint(reports[0].sampleId);
  t.mock.timers.tick(200);
  assert.equal(reports.length, 2);
});

for (const [reason, stop] of Object.entries({
  hiding: ({ document }) => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
  pausing: ({ game }) => game.track(false),
  exiting: ({ game }) => game.exitParticipation(),
  disconnecting: ({ socket }) => socket.disconnect(),
  'switching sessions': ({ game }) => game.changeProfile({ stage: 'evening' }),
})) {
  test(`${reason} cancels the pending resend`, { timeout: 5000 }, async (t) => {
    const live = await liveMap(t);
    live.fix();
    live.retryHint();
    await stop(live);
    t.mock.timers.tick(200);
    assert.equal(live.reports.length, 1);
  });
}
