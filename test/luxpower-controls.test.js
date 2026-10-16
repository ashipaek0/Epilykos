'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../modules/dongle/luxpowerSettings');
const profile = require('../profiles/dongles/luxpower-geta.json');
const flag = profile.geta_controls.find(w => w.name === 'ac_charge_enabled');
const power = profile.geta_controls.find(w => w.name === 'charge_power_percent');
const time = profile.geta_controls.find(w => w.name === 'ac_charge_start_time_1');
function fake(words = {}) {
  const raw = { 19: 26, 21: 0x8101, 64: 50, 68: 0x1e0a, ...words }, writes = [];
  return { raw, writes, async readRegisters(start, count, fn) { const b = Buffer.alloc(2 * count); for (let i = 0; i < count; i++) b.writeUInt16LE(fn === 4 ? 0 : raw[start + i] || 0, i * 2); return b; }, async writeRegister(r, v) { writes.push([r, v]); raw[r] = v; } };
}
test('GETA controls have traced identifiers, bounds and explicit hardware-unverified status', () => {
  assert.equal(profile.geta_controls.length, 12);
  assert.ok(profile.geta_controls.every(w => w.evidence && w.hardware_verified === false));
});
test('new controls require live GETA identity and a readable valid current value', async () => {
  for (const model of [0, 27, 12]) {
    const t = fake({ 19: model }); assert.equal((await s.read(t, power)).writable, false);
    assert.equal((await s.change(t, power, 50, 60)).success, false); assert.equal(t.writes.length, 0);
  }
  assert.equal((await s.read(fake({ 64: 101 }), power)).writable, false);
});
test('flag writes preserve every unrelated bit and validate full-word readback', async () => {
  const t = fake(); const r = await s.change(t, flag, false, true);
  assert.equal(r.success, true); assert.equal(t.raw[21], 0x8181); assert.equal(r.raw, 0x8181);
  const bad = fake(); bad.writeRegister = async () => { bad.raw[21] = 0x80; };
  assert.equal((await s.change(bad, flag, false, true)).status, 'mismatch');
});
test('expected values and types are mandatory, stale changes and noops send nothing', async () => {
  const t = fake();
  for (const [expected, value] of [[undefined, 60], [40, 60], [50, 100.5], [50, '60'], [50, -1]]) assert.equal((await s.change(t, power, expected, value)).success, false);
  assert.equal((await s.change(t, power, 50, 50)).unchanged, true); assert.equal(t.writes.length, 0);
});
test('times encode hour low/minute high, invalid hardware values block changes', async () => {
  const t = fake(); assert.equal((await s.read(t, time)).value, '10:30');
  assert.equal((await s.change(t, time, '10:30', '23:59')).success, true); assert.equal(t.raw[68], 0x3b17);
  for (const v of ['24:00', '12:60', '1:30', 100]) assert.throws(() => s.encode(time, v));
  assert.equal((await s.read(fake({ 68: 0xffff }), time)).writable, false);
});
test('write timeout is ambiguous, never retries; switch-off during preflight refuses', async () => {
  const t = fake(); let n = 0; t.writeRegister = async () => { n++; throw new Error('timeout'); };
  const r = await s.change(t, power, 50, 60); assert.equal(r.written, true); assert.equal(r.status, 'sent_unverified'); assert.equal(n, 1);
  const off = fake(); assert.equal((await s.change(off, power, 50, 60, () => false)).success, false); assert.equal(off.writes.length, 0);
});
test('per-device transactions serialize two flag changes without losing bits', async () => {
  const t = fake(); const second = profile.geta_controls.find(w => w.name === 'charge_first_enabled');
  await Promise.all([s.serialized('test', () => s.change(t, flag, false, true)), s.serialized('test', () => s.change(t, second, false, true))]);
  assert.equal(t.raw[21], 0x8981);
});
test('verification never writes; partial failures remain visible and unknowns stay null', async () => {
  const t = fake(); const original = t.readRegisters;
  t.readRegisters = async (start, count, fn) => { if (fn === 4 && start === 80) throw new Error('unsupported'); return original(start, count, fn); };
  const r = await s.snapshot(t, profile, { name: 'test', profile: 'luxpower-geta' });
  assert.equal(r.identity.model.geta, true); assert.equal(r.complete, false); assert.equal(r.decoded.bmsMaxChargeCurrent, null);
  assert.ok(r.reads.some(x => x.error === 'unsupported')); assert.equal(t.writes.length, 0);
});

test('offline verification checks target bits, tolerates clock ticks and refuses identity changes', async () => {
  const { compare } = require('../scripts/verify-luxpower-snapshots');
  const t = fake(); const dev = { name: 'test', profile: 'luxpower-geta', dongle_serial: 'DT00000001', inverter_serial: 'IN00000001' };
  const before = await s.snapshot(t, profile, dev);
  t.raw[21] |= 128; t.raw[12] = 55;
  const after = await s.snapshot(t, profile, dev);
  assert.equal(compare(before, after, 'ac_charge_enabled', 'true').matched, true);
  after.raw.holding[21] ^= 1;
  assert.equal(compare(before, after, 'ac_charge_enabled', 'true').matched, false);
  after.serials.inverter = 'IN00000002';
  assert.throws(() => compare(before, after, 'ac_charge_enabled', 'true'), /identity changed/);
});
