'use strict';
const checks = require('./_checks');
// The profile checker: what it rejects, and that every shipped Modbus profile passes it.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { checkProfile } = require('../modules/profileCheck');

const reg = (o) => Object.assign({ metric: 'pv_power', address: 1, type: 'uint16', scale: 1, unit: 'W', label: 'PV power' }, o);
const good = (regs) => ({ name: 'Test', connection: 'rtu', defaultUnitId: 1, registers: regs || [reg()] });
const errs = (p) => checkProfile(p).filter(f => f.level === 'error');
const has = (p, re) => checkProfile(p).some(f => re.test(f.message));

assert.deepEqual(checkProfile(good()), [], 'a clean profile has no findings');
assert.ok(errs(null).length && errs([]).length, 'not an object');
assert.ok(has({ ...good(), name: ' ' }, /needs a name/));
assert.ok(has({ ...good(), connection: 'serial' }, /"rtu".*"tcp"/));
assert.ok(has({ ...good(), defaultUnitId: 0 }, /1 to 247/));
assert.ok(has({ ...good(), defaultUnitId: 1.5 }, /1 to 247/));
assert.ok(has({ ...good(), status: 'great' }, /status, when given/));
assert.equal(errs({ ...good(), status: 'unverified', source: 'Vendor protocol v1.2' }).length, 0, 'status and source are allowed');
assert.ok(has({ ...good(), registers: [] }, /at least one/));
assert.ok(has({ ...good(), function: 'coil' }, /holding.*input/));
assert.ok(has({ ...good(), wordOrder: 'backwards' }, /msw_first/));
assert.equal(errs({ ...good(), function: 'input', wordOrder: 'lsw_first' }).length, 0, 'profile-level function and word order');
assert.ok(has(good([reg({ function: 'x' })]), /function must be/));
assert.ok(has(good([reg({ type: 'uint32', word_order: 'x' })]), /word_order must be/));
assert.equal(checkProfile(good([reg({ word_order: 'lsw_first' })])).find(f => /only matters for 32/.test(f.message)).level, 'warn', 'word order on a 16-bit value');
assert.equal(errs(good([reg({ type: 'uint32', word_order: 'lsw_first', function: 'input' })])).length, 0);
// Holding and input registers are separate address spaces: the same number may appear in both.
assert.equal(errs(good([reg({ metric: 'a', address: 5 }), reg({ metric: 'b', address: 5, function: 'input' })])).length, 0);
assert.ok(has(good([reg({ metric: 'a', address: 5, function: 'input' }), reg({ metric: 'b', address: 5, function: 'input' })]), /shares address/));
assert.ok(has({ ...good([reg({ metric: 'a', type: 'uint32', address: 5 }), reg({ metric: 'b', address: 6 })]), function: 'input' }, /inside/), 'profile-level function applies to the overlap check');

assert.ok(has(good([reg({ metric: 'PV Power' })]), /lower-case/));
assert.ok(has(good([reg(), reg({ address: 2 })]), /already used/), 'duplicate metric names');
assert.ok(has(good([reg({ type: 'float' })]), /type must be one of/));
assert.ok(has(good([reg({ address: -1 })]), /0 to 65535/));
assert.ok(has(good([reg({ address: 70000 })]), /0 to 65535/));
assert.ok(has(good([reg({ address: '33000' })]), /0 to 65535/), 'an address given as text');
assert.ok(has(good([reg({ scale: 0 })]), /non-zero/));
assert.ok(has(good([reg({ scale: '0.1' })]), /non-zero number/));
assert.ok(has(good([reg({ label: '' })]), /label/));
assert.ok(has(good([reg({ unit: undefined })]), /unit must be text/));
assert.equal(checkProfile(good([reg({ scale: 100000 })])).find(f => /unusual/.test(f.message)).level, 'warn', 'odd scale is a warning');
assert.equal(checkProfile(good([reg({ unit: 'furlongs' })])).find(f => /not one the app knows/.test(f.message)).level, 'warn');
assert.ok(has(good([reg({ colour: 'red' })]), /not a field the poller reads/));

// 32-bit values cover the next register; 64-bit the next three.
assert.ok(has(good([reg({ type: 'int32', metric: 'a', address: 10 }), reg({ metric: 'b', address: 11 })]), /inside/));
assert.ok(has(good([reg({ type: 'uint64', metric: 'a', address: 10 }), reg({ metric: 'b', address: 13 })]), /inside/));
assert.equal(errs(good([reg({ type: 'uint64', metric: 'a', address: 10 }), reg({ metric: 'b', address: 14 })])).length, 0);
assert.ok(has(good([reg({ metric: 'a', address: 5 }), reg({ metric: 'b', address: 5 })]), /shares address/), 'two metrics at one address');
assert.equal(errs(good([reg({ type: 'uint32', metric: 'a', address: 10 }), reg({ metric: 'b', address: 12 })])).length, 0, 'a neighbour right after the pair is fine');

// Every shipped Modbus profile passes, with no allowances.
const KNOWN = {};
const dir = path.join(__dirname, '..', 'profiles');
let n = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const found = errs(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const allowed = KNOWN[f] || [];
  const left = found.filter(x => !allowed.some(re => re.test(x.where)));
  assert.deepEqual(left, [], `${f} should pass the profile checker`);
  n++;
}
assert.ok(n >= 14, 'looked at the shipped profiles');
console.log('ok - profile checker');
checks.done();
