'use strict';
const checks = require('./_checks');
// What the server sends to open dashboards for a new state
// (modules/broadcastPlan.js), and that a state too large to send whole no
// longer stops live updates for good.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { planBroadcast, MAX_MESSAGE_BYTES } = require('../modules/broadcastPlan');
const type = p => (p.message ? JSON.parse(p.message).type : null);

assert.equal(MAX_MESSAGE_BYTES, 1024 * 1024);
const state = { current: { watts: 10, soc: 50 }, metrics: { a: 1, b: 2, c: 3, d: 4, e: 5 }, history: [1, 2, 3, 4, 5, 6, 7, 8] };

// Nothing changed: quiet for two polling cycles, then the whole state once.
let p = planBroadcast({ state, delta: {}, quietCycles: 0 });
assert.deepEqual([p.message, p.quietCycles], [null, 1]);
p = planBroadcast({ state, delta: {}, quietCycles: 1 });
assert.deepEqual([p.message, p.quietCycles], [null, 2]);
p = planBroadcast({ state, delta: {}, quietCycles: 2 });
assert.equal(type(p), 'dashboard-state'); assert.equal(p.quietCycles, 0);
// A live push between cycles that changed nothing: nothing, and the count stands.
p = planBroadcast({ state, delta: {}, quietCycles: 2, live: true });
assert.deepEqual([p.message, p.quietCycles], [null, 2]);
console.log('ok - no change: nothing for two cycles, the whole state on the third; never for a live push');

// A small change goes as a change; a change that is most of the state goes whole.
p = planBroadcast({ state, delta: { current: { watts: 11 } }, quietCycles: 2 });
assert.equal(type(p), 'dashboard-delta'); assert.deepEqual(JSON.parse(p.message).data, { current: { watts: 11 } }); assert.equal(p.quietCycles, 0);
p = planBroadcast({ state, delta: state, quietCycles: 0 });
assert.equal(type(p), 'dashboard-state');
console.log('ok - a small change is sent as a change, a large one as the whole state');

// The whole state is too large to send: the change goes instead (it used to be refused,
// and every later change with it).
const big = { ...state, history: Array.from({ length: 400 }, (_, i) => i) };
const limit = 600;
assert.ok(Buffer.byteLength(JSON.stringify(big)) > limit);
p = planBroadcast({ state: big, delta: { current: { watts: 12 } }, quietCycles: 0, maxBytes: limit });
assert.equal(type(p), 'dashboard-delta', 'a small change still gets through');
assert.equal(p.tooLarge, 0);
// Quiet third cycle with an oversized state: skipped without harm, and the count starts over.
p = planBroadcast({ state: big, delta: {}, quietCycles: 2, maxBytes: limit });
assert.deepEqual([p.message, p.quietCycles, p.tooLarge], [null, 0, 0]);
// A change that would rather go whole, but the whole is too large: the change, if it fits.
const mostly = { metrics: { a: 9, b: 9, c: 9, d: 9, e: 9 }, current: { watts: 1, soc: 2 }, history: [9, 9, 9, 9, 9, 9, 9, 9] };
p = planBroadcast({ state, delta: mostly, quietCycles: 0, maxBytes: Buffer.byteLength(JSON.stringify({ type: 'dashboard-delta', data: mostly })) });
assert.equal(type(p), 'dashboard-delta');
// Neither fits: nothing is sent, and it says how large it was.
p = planBroadcast({ state: big, delta: big, quietCycles: 0, maxBytes: limit });
assert.equal(p.message, null); assert.ok(p.tooLarge > limit);
console.log('ok - an oversized state no longer stops live updates: the change is sent instead');

// The server uses it, logs an oversized update once, and the old 64 KB block is gone.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(server, /planBroadcast\(\{ state, delta: computeDelta\(state, channel\.last\), quietCycles: channel\.quiet, live \}\)/);
assert.match(server, /if \(!channel\.tooLargeLogged\) logger\.warn/);
assert.doesNotMatch(server, /exceeds 64KB limit/);
checks.done();
