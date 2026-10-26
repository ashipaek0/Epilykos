'use strict';
const checks = require('./_checks');
// The 24 V LuxPowerTek GETA 3.6 kW profile (one MPPT, single phase, off-grid
// style): only the registers that unit has, read in 40-register blocks that
// never cross a boundary, decoded the way its register table says.
const assert = require('node:assert/strict');
const profile = require('../profiles/dongles/luxpower-geta-3k6-24v.json');
const full = require('../profiles/dongles/luxpower-geta.json');
const { decodeLuxpowerMetrics } = require('../modules/dongle');

const addr = m => parseInt(m.register, 16);

// Same family as the general GETA profile: same transport, mapping and word order.
for (const k of ['protocol', 'transport', 'default_port', 'byte_order', 'mapping']) assert.equal(profile[k], full[k], k);
assert.equal(profile.capabilities.write, true);
console.log('ok - same dongle family as the general GETA profile');

// Nothing that belongs to other hardware.
const other = /(^|_)pv[2-6]_|_s$|_t$|_s_|_l[12]n|auto_test|smart_load|ac_couple|ct_power|lead_acid|unmapped|bms_status_|half_bus|master_slave|ntc_|exception_reason|reactive/;
assert.deepEqual(profile.metrics.filter(m => other.test(m.name)).map(m => m.name), [], 'no PV2-6, S/T phase, split-phase, AFCI/auto-test or meter registers');
assert.ok(profile.metrics.length < full.metrics.length / 1.5, `${profile.metrics.length} of ${full.metrics.length}`);
const inputAddrs = new Set(profile.metrics.filter(m => m.register_type === 'input').map(addr));
for (const a of [2, 3, 8, 9, 13, 14, 21, 22, 29, 30, 42, 43, 44, 45, 71, 72, 73, 74, 75, 217, 231]) assert.ok(!inputAddrs.has(a), `input ${a} is not on this unit`);
console.log('ok - no registers of other hardware');

// 40-register blocks, never crossing 0-39 / 40-79 / 80-119 / 120-159 / 160-199.
for (const space of ['input', 'holding']) {
  for (const [start, count] of profile.read_ranges[space]) {
    assert.equal(start % 40, 0, `${space} ${start}`);
    assert.ok(count <= 40, `${space} ${start}+${count}`);
  }
}
const inRanges = (space, a, n = 1) => profile.read_ranges[space].some(([s, c]) => a >= s && a + n <= s + c);
for (const m of profile.metrics) assert.ok(inRanges(m.register_type, addr(m), m.count), `${m.name} is read`);
for (const w of [...profile.writable_registers, ...profile.geta_controls]) assert.ok(inRanges('holding', addr(w)), `${w.name} is read back`);
assert.deepEqual(profile.read_ranges.input.map(r => r[0]), [0, 40, 80, 120, 160]);
console.log('ok - 40-register blocks, every metric and control inside one');

const names = profile.metrics.map(m => m.name);
assert.equal(new Set(names).size, names.length, 'metric names are unique');
const slots = profile.metrics.map(m => `${m.register_type}:${m.register}:${m.decode || ''}`);
assert.equal(new Set(slots).size, slots.length, 'one entry per register (and decode)');
assert.equal(profile.geta_controls.length, 12);
assert.ok(profile.geta_controls.every(w => w.evidence && w.hardware_verified === false));
console.log('ok - unique names, the twelve named controls kept');

// Decode a frame the way the register table describes it.
const words = {
  'holding:19': 26,                                      // single-phase GETA identity word
  'input:0': 0xC0, 'input:1': 1500, 'input:4': 266,      // PV+battery off-grid, 150.0 V, 26.6 V
  'input:5': (98 << 8) | 55,                             // SOC 55 % in the low byte (the high byte is SOH)
  'input:7': 820, 'input:10': 540, 'input:11': 0,
  'input:12': 2301, 'input:15': 5002, 'input:20': 2300, 'input:24': 640,
  'input:28': 123, 'input:40': 0x0003, 'input:41': 0x0001, // 65539 x 0.1 kWh, low word first
  'input:64': 41, 'input:65': 0xFFFB, 'input:67': 30,    // heatsink -5 C
  'input:80': 2, 'input:81': 5000, 'input:98': 0xFF9C,   // lithium, 50.00 A limit, BMS current -1.00 A
  'input:101': 3350, 'input:104': 0xFFF6,                // 3.350 V, -1.0 C
  'input:170': 310, 'input:172': 100, 'input:173': 0,
  'holding:99': 284, 'holding:100': 210, 'holding:101': 60, 'holding:105': 20,
  'holding:145': 1, 'holding:162': 220,
};
const instance = { mappings: Object.fromEntries(profile.metrics.map(m => [m.name, `${m.register_type}:${m.register}`])) };
const { metrics, units } = decodeLuxpowerMetrics(profile, instance, words);
const expect = {
  operational_state: 192, pv1_voltage: 150, battery_voltage: 26.6, battery_soc: 55, pv1_power: 820,
  battery_charge_power: 540, grid_voltage: 230.1, grid_frequency: 50.02, eps_voltage: 230, eps_power: 640,
  pv1_energy_today: 12.3, pv1_energy_total: 6553.9, internal_temperature: 41, radiator_temperature_1: -5, battery_temperature: 30,
  bms_max_charge_current: 50, bms_battery_current: -1, bms_max_cell_voltage: 3.35, bms_min_cell_temperature: -1,
  load_power: 310, load_energy_total: 10, charge_voltage_ref: 28.4, discharge_cutoff_voltage_ref: 21, max_charge_current: 60,
  eod_soc: 20, output_priority: 1, battery_low_voltage: 22,
};
for (const [k, v] of Object.entries(expect)) assert.equal(metrics[k], v, k);
assert.equal(units.battery_voltage, 'V'); assert.equal(units.pv1_energy_today, 'kWh');
console.log('ok - values decode as the register table says (SOC byte, signed, 32-bit, 24 V settings)');

// SOC is the low byte only; the SOH byte above it never leaks into it.
assert.equal(decodeLuxpowerMetrics(profile, { mappings: { b: 'input:0x0005' } }, { 'input:5': (87 << 8) | 61 }).metrics.b, 61);
console.log('ok - SOC is the low byte only');
checks.done();
