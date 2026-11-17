'use strict';
const checks = require('./_checks');
// The dashboard's live connection (public/js/ws-manager.js): it never stops
// trying to reconnect, a connection that is plainly alive is kept when the
// page comes back to the front, and a quiet one is replaced.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const script = read('public/js/ws-manager.js').replace(/^export /gm, '');

function fixture() {
  let now = 1e9;
  const sockets = [], timers = [], listeners = {};
  const context = {
    console: { debug() {}, warn() {}, error() {} },
    indexedDB: { open() { throw new Error('none'); } },
    window: { location: { protocol: 'http:', host: 'localhost' }, dispatchEvent() {} },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i.detail; } },
    WebSocket: class { constructor() { this.readyState = 0; sockets.push(this); } close() { this.readyState = 3; } },
    Date: { now: () => now },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    navigator: {}, self: {},
    document: { visibilityState: 'visible', addEventListener: (t, fn) => { listeners[t] = fn; } },
  };
  vm.runInNewContext(script, context);
  context.connectWebSocket({ onMessage() {} });
  context.setupBackgroundSync();
  return {
    context, sockets, timers, listeners,
    advance(ms) { now += ms; },
    open(s) { s.readyState = 1; s.onopen(); },
    message(s) { return s.onmessage({ data: JSON.stringify({ type: 'dashboard-state', data: { a: 1 } }) }); },
    drop(s) { s.readyState = 3; s.onclose(); },
    fire() { const t = timers.filter(x => !x.cancelled && !x.done).pop(); t.done = true; t.fn(); return t.ms; },
  };
}

(async () => {
  // It keeps trying: quickly at first, then once a minute, for as long as the page is open.
  const f = fixture();
  const delays = [];
  for (let i = 0; i < 40; i++) { f.drop(f.sockets[f.sockets.length - 1]); delays.push(f.fire()); }
  assert.deepEqual(delays.slice(0, 6), [1000, 2000, 5000, 10000, 30000, 30000]);
  assert.equal(delays[29], 30000, 'the 30th attempt is still at the fast pace');
  assert.deepEqual(delays.slice(30), Array(10).fill(60000), 'after that, once a minute, without end');
  assert.equal(f.sockets.length, 41, 'every attempt opened a new connection');
  console.log('ok - the live connection never gives up: 13 minutes of quick attempts, then once a minute');

  // A connection again: the pace starts over.
  f.open(f.sockets[f.sockets.length - 1]);
  f.drop(f.sockets[f.sockets.length - 1]);
  assert.equal(f.fire(), 1000, 'after a success it starts from the short delay again');

  // Back to the front with a connection that is plainly alive: it is kept.
  const g = fixture();
  g.open(g.sockets[0]); await g.message(g.sockets[0]);
  g.advance(5000);
  g.listeners.visibilitychange();
  assert.equal(g.sockets.length, 1, 'a live connection is not replaced on a tab switch');
  assert.equal(g.context.liveWithin(30000), true);
  // Quiet for a while (a phone that slept): it is replaced.
  g.advance(60000);
  assert.equal(g.context.liveWithin(30000), false);
  g.listeners.visibilitychange();
  assert.equal(g.sockets.length, 2, 'a quiet connection is replaced');
  // Open but nothing received yet, or closed: not live.
  assert.equal(g.context.liveWithin(30000), false, 'the new connection has delivered nothing yet');
  g.context.document.visibilityState = 'hidden';
  g.listeners.visibilitychange();
  assert.equal(g.sockets.length, 2, 'going to the background does nothing');
  console.log('ok - coming back to the page keeps a live connection and replaces a quiet one');

  // The page's own 30 s fetch stands down while the live connection delivers.
  assert.match(read('public/js/main.js'), /setInterval\(async \(\) => \{\s*if \(liveWithin\(30000\)\) return;/, 'no second fetch while live data arrives');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
