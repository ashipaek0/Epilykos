'use strict';
const checks = require('./_checks');
// Between polling cycles, new readings reach the open pages within seconds
// (modules/livePush.js): throttled, only while someone is watching, never on
// top of a running cycle.
const assert = require('node:assert/strict');
const { createLivePush } = require('../modules/livePush');

function setup(over = {}) {
  let t = 1e6, id = 0;
  const timers = new Map(), sent = [];
  const s = {
    clients: true, current: true, cycle: false, fail: false,
    advance(ms) { t += ms; for (const [k, v] of [...timers]) if (v.at <= t) { timers.delete(k); v.fn(); } },
    sent, timers,
  };
  s.push = createLivePush({
    minMs: 5000, settleMs: 250, now: () => t,
    hasClients: () => s.clients, isCurrent: () => s.current, busy: () => s.cycle,
    build: async () => { if (s.fail) throw new Error('db busy'); return { at: t }; },
    send: state => sent.push(state),
    setTimer: (fn, ms) => { const k = ++id; timers.set(k, { fn, at: t + ms }); return k; },
    clearTimer: k => timers.delete(k),
    ...over,
  });
  return s;
}
const settle = () => new Promise(r => setImmediate(r));

(async () => {
  // A request pushes after a short settle, and a burst of requests is one push.
  let s = setup();
  s.push.request(); s.push.request(); s.push.request();
  assert.equal(s.timers.size, 1, 'a burst is one pending push');
  s.advance(249); await settle(); assert.equal(s.sent.length, 0, 'not before the settle time');
  s.advance(1); await settle(); assert.equal(s.sent.length, 1);
  console.log('ok - readings reach the pages after a short settle; a burst is one push');

  // No more than one push per 5 s.
  s.push.request(); s.advance(250); await settle();
  assert.equal(s.sent.length, 1, 'a second push is held back');
  s.advance(4000); await settle(); assert.equal(s.sent.length, 1);
  s.advance(1000); await settle(); assert.equal(s.sent.length, 2, 'it goes out when 5 s have passed since the last one');
  console.log('ok - at most one push every 5 seconds');

  // The polling cycle's own push counts.
  s = setup(); s.push.notePush();
  s.push.request(); s.advance(4999); await settle(); assert.equal(s.sent.length, 0);
  s.advance(1); await settle(); assert.equal(s.sent.length, 1);
  console.log('ok - a push by the polling cycle holds the next one back');

  // Nobody watching: nothing is scheduled, nothing is built.
  s = setup({ build: async () => { throw new Error('must not build'); } }); s.clients = false;
  s.push.request(); assert.equal(s.timers.size, 0);
  // Everyone leaves while a push is waiting.
  s = setup(); s.push.request(); s.clients = false; s.advance(300); await settle();
  assert.equal(s.sent.length, 0, 'the last page left: nothing is sent');
  console.log('ok - nothing happens while no page is open');

  // A running polling cycle pushes by itself: the request is dropped.
  s = setup(); s.cycle = true; s.push.request(); s.advance(300); await settle();
  assert.equal(s.sent.length, 0);
  s.cycle = false; s.push.request(); s.advance(300); await settle();
  assert.equal(s.sent.length, 1, 'requests work again once the cycle is over');
  console.log('ok - a running polling cycle is not duplicated');

  // A retired database or a failed build sends nothing and recovers.
  s = setup(); s.current = false; s.push.request(); s.advance(300); await settle(); assert.equal(s.sent.length, 0);
  s = setup(); s.fail = true; s.push.request(); s.advance(300); await settle(); assert.equal(s.sent.length, 0);
  s.fail = false; s.push.request(); s.advance(300); await settle(); assert.equal(s.sent.length, 1, 'a later request works after a failed build');
  console.log('ok - a failed build or a retired database sends nothing and recovers');

  s = setup(); s.push.request(); s.push.stop(); assert.equal(s.timers.size, 0);
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
