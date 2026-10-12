'use strict';
const checks = require('./_checks');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const script = fs.readFileSync(path.join(__dirname, '../public/js/ws-manager.js'), 'utf8').replace(/^export /gm, '');

function fixture(storage) {
  const sockets = [], full = [], partial = [];
  const context = {
    console: { debug() {}, warn() {}, error() {} },
    indexedDB: storage,
    window: { location: { protocol: 'http:', host: 'localhost' }, dispatchEvent(e) { partial.push(JSON.parse(JSON.stringify(e.detail.state))); } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    WebSocket: class { constructor() { sockets.push(this); } close() {} },
    setTimeout, clearTimeout, navigator: {}, document: {}, self: {},
  };
  vm.runInNewContext(script, context);
  const connect = () => context.connectWebSocket({ onMessage: s => full.push(JSON.parse(JSON.stringify(s))) });
  connect();
  return { sockets, full, partial, connect, context };
}
const message = (socket, type, data) => socket.onmessage({ data: JSON.stringify({ type, data }) });

(async () => {
  const blocked = fixture({ open() { throw new Error('IndexedDB unavailable'); } });
  assert.strictEqual(await blocked.context.loadInitialState(), null);
  await message(blocked.sockets[0], 'dashboard-state', { metrics: { watts: 10, battery: 40 } });
  await message(blocked.sockets[0], 'dashboard-delta', { metrics: { watts: 20 } });
  await message(blocked.sockets[0], 'dashboard-delta', { metrics: { battery: 50 } });
  assert.deepStrictEqual(blocked.full, [{ metrics: { watts: 10, battery: 40 } }]);
  assert.deepStrictEqual(blocked.partial.at(-1), { metrics: { watts: 20, battery: 50 } });

  // A cache open that never completes must neither block rendering nor lose
  // consecutive deltas while earlier cache writes are still awaiting storage.
  const stalled = fixture({ open() { return {}; } });
  message(stalled.sockets[0], 'dashboard-state', { metrics: { watts: 10, battery: 40 } });
  message(stalled.sockets[0], 'dashboard-delta', { metrics: { watts: 20 } });
  message(stalled.sockets[0], 'dashboard-delta', { metrics: { battery: 50 } });
  assert.strictEqual(stalled.full.length, 1);
  assert.strictEqual(stalled.partial.length, 2);
  assert.deepStrictEqual(stalled.partial[1], { metrics: { watts: 20, battery: 50 } });

  const old = blocked.sockets[0];
  blocked.connect();
  await message(old, 'dashboard-state', { metrics: { watts: 99 } });
  await message(blocked.sockets[1], 'dashboard-delta', { metrics: { watts: 30 } });
  assert.strictEqual(blocked.full.length, 1, 'messages from a retired socket are ignored');
  assert.strictEqual(blocked.partial.length, 2, 'a new socket waits for its own full snapshot');
  await message(blocked.sockets[1], 'dashboard-state', { metrics: { watts: 5 } });
  await message(blocked.sockets[1], 'dashboard-delta', { metrics: { watts: 6 } });
  assert.deepStrictEqual(blocked.partial.at(-1), { metrics: { watts: 6 } });
  console.log('ok - live state survives unavailable or stalled storage, rapid deltas and reconnects');
  checks.done();
})().catch(e => { console.error(e); process.exitCode = 1; });
