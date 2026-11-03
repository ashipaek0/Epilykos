'use strict';
// LuxPower registers and controls added for parity with the Home Assistant
// lxp_modbus integration (ant0nkr/luxpower-ha-integration). Addresses, scales
// and choices come from its source and the LuxPower protocol document it
// transcribes. The new named controls keep the existing write rules: identity
// read first, current value in range, typed expected value, other bits kept,
// exact full-word readback. Nothing here talks to hardware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'lux-parity-')));
const s = require('../modules/dongle/luxpowerSettings');
const { decodeLuxpowerMetrics } = require('../modules/dongle');
const generic = require('../profiles/dongles/luxpower-geta.json');
const v24 = require('../profiles/dongles/luxpower-geta-3k6-24v.json');

const GETA_APP_CONTROLS = ['charge_power_percent', 'discharge_power_percent', 'ac_charge_power_percent', 'ac_charge_enabled',
  'charge_first_enabled', 'forced_discharge_enabled', 'ac_charge_start_time_1', 'ac_charge_end_time_1',
  'ac_charge_start_time_2', 'ac_charge_end_time_2', 'ac_charge_start_time_3', 'ac_charge_end_time_3'];
const control = (p, name) => {
  const w = p.geta_controls.find(c => c.name === name);
  assert.ok(w, `${name} is a named control`);
  return w;
};
const added = p => p.geta_controls.filter(w => !GETA_APP_CONTROLS.includes(w.name));
const reg = w => parseInt(w.register, 16);
// GETA identity word: single phase, device type 13. 12 is a single-phase type 6 (12K family).
const GETA = 26, NOT_GETA = 12;
function fake(words = {}) {
  const raw = { 19: GETA, ...words }, writes = [];
  return { raw, writes,
    async readRegisters(start, count, fn) { const b = Buffer.alloc(2 * count); for (let i = 0; i < count; i++) b.writeUInt16LE(fn === 4 ? 0 : raw[start + i] || 0, i * 2); return b; },
    async writeRegister(r, v) { writes.push([r, v]); raw[r] = v; } };
}

test('new controls are declared like the GETA ones: evidence, family, hardware-unverified, polled range', () => {
  assert.equal(generic.geta_controls.length, 50);
  assert.equal(added(generic).length, 38);
  assert.equal(v24.geta_controls.length, 24);
  for (const [p, family] of [[generic, 'luxpower'], [v24, 'geta']]) {
    for (const w of added(p)) {
      assert.ok(w.evidence && w.label && w.description, w.name);
      assert.doesNotMatch(w.description, /hardware|lxp_modbus|register|byte/i, `${w.name}: help text says what it does`);
      assert.equal(w.hardware_verified, false, w.name);
      assert.equal(w.geta_control, true, w.name);
      assert.equal(w.register_type, 'holding', w.name);
      assert.equal(w.family, family, `${w.name} family`);
      assert.ok(p.read_ranges.holding.some(([st, n]) => reg(w) >= st && reg(w) < st + n), `${w.name} is read back`);
    }
    // The LuxCloud GETA controls keep the GETA identity check.
    for (const name of GETA_APP_CONTROLS) assert.equal(control(p, name).family, undefined, name);
    const names = p.geta_controls.map(w => w.name);
    assert.equal(new Set(names).size, names.length, 'control names are unique');
  }
});

test('the 24 V profile only gets controls for registers its own register table lists', () => {
  const polled = new Set(v24.metrics.filter(m => m.register_type === 'holding').map(reg));
  for (const w of added(v24)) {
    assert.ok(polled.has(reg(w)), `${w.name}: holding ${w.register} is in the 24 V profile`);
    assert.deepEqual({ ...w, family: 'luxpower' }, control(generic, w.name), `${w.name} matches the generic definition`);
  }
});

test('no controls for grid protection, identity, resets, standby, backup output or EPS settings', () => {
  const banned = new Set([11, 12, 13, 14, 15, 16, 19, 20, 22, 90, 91, 112, 113, 114, 119, 176, 179, 180, 225, 231]);
  for (let r = 23; r <= 63; r++) banned.add(r);
  for (let r = 92; r <= 97; r++) banned.add(r);
  for (let r = 181; r <= 193; r++) banned.add(r);
  for (const p of [generic, v24]) {
    for (const w of [...p.geta_controls, ...p.writable_registers]) assert.ok(!banned.has(reg(w)), `${w.name} at ${w.register}`);
    // Register 21: only grid charging (7), forced discharge (10), charge first (11) and export (15).
    for (const w of p.geta_controls.filter(c => reg(c) === 21)) assert.ok([0x80, 0x400, 0x800, 0x8000].includes(w.mask), w.name);
  }
});

test('numeric controls use the documented ranges and refuse anything else', () => {
  const table = {
    ac_charge_soc_limit: [0x43, 0, 100, '%'], charge_first_power_percent: [0x4A, 0, 100, '%'],
    forced_discharge_power_percent: [0x52, 0, 100, '%'], forced_discharge_soc_limit: [0x53, 0, 100, '%'],
    max_charge_current: [0x65, 0, 140, 'A'], max_discharge_current: [0x66, 0, 140, 'A'],
    max_backflow_power_percent: [0x67, 0, 100, '%'], ac_charge_battery_current: [0xA8, 0, 140, 'A'],
  };
  for (const [name, [address, min, max, unit]] of Object.entries(table)) {
    const w = control(generic, name);
    assert.deepEqual([reg(w), w.kind, w.min, w.max, w.step, w.scale, w.unit], [address, 'value', min, max, 1, 1, unit], name);
    assert.equal(s.descriptor(w).type, 'number');
    for (const ok of [min, max]) assert.doesNotThrow(() => s.encode(w, ok), `${name} ${ok}`);
    for (const bad of [min - 1, max + 1, min + 0.5, String(max), null]) assert.throws(() => s.encode(w, bad), `${name} ${bad}`);
  }
});

test('a current outside the documented range blocks the control and sends nothing', async () => {
  const w = control(generic, 'max_charge_current');
  const t = fake({ 101: 200 });
  const r = await s.read(t, w);
  assert.equal(r.value, 200); assert.equal(r.writable, false); assert.match(r.blockedReason, /outside/);
  assert.equal((await s.change(t, w, 200, 100)).success, false);
  assert.deepEqual(t.writes, []);
  const ok = fake({ 101: 60 });
  assert.equal((await s.change(ok, w, 60, 80)).status, 'verified');
  assert.deepEqual(ok.writes, [[101, 80]]);
});

test('the forced discharge SOC limit is the low byte; the high byte is kept', async () => {
  const w = control(generic, 'forced_discharge_soc_limit');
  assert.equal(w.mask, 0x00FF);
  const t = fake({ 83: 0x0314 });
  assert.equal((await s.read(t, w)).value, 20);
  const r = await s.change(t, w, 20, 30);
  assert.equal(r.status, 'verified'); assert.deepEqual(t.writes, [[83, 0x031E]]);
  assert.equal((await s.read(fake({ 83: 0x00FF }), w)).writable, false, '255 % is not a SOC');
});

test('switches name their bit and keep every other bit', async () => {
  const table = { feed_in_grid_enabled: [21, 0x8000], fast_zero_export_enabled: [110, 0x0002], charge_last_enabled: [110, 0x0010],
    buzzer_enabled: [110, 0x0080], green_mode_enabled: [110, 0x4000], eco_mode_enabled: [110, 0x8000] };
  for (const [name, [address, mask]] of Object.entries(table)) {
    const w = control(generic, name);
    assert.deepEqual([reg(w), w.kind, w.mask], [address, 'bitfield', mask], name);
    assert.equal(s.descriptor(w).type, 'switch');
  }
  const t = fake({ 110: 0x0C81 });
  const r = await s.change(t, control(generic, 'eco_mode_enabled'), false, true);
  assert.equal(r.status, 'verified'); assert.deepEqual(t.writes, [[110, 0x8C81]]);
  const off = fake({ 21: 0x8181 });
  await s.change(off, control(generic, 'feed_in_grid_enabled'), true, false);
  assert.deepEqual(off.writes, [[21, 0x0181]]);
});

test('selectors offer only the documented choices and change only their own bits', async () => {
  const table = {
    ac_charge_type: [120, 0x000E, ['Off', 'Time windows', 'Battery voltage', 'Battery level', 'Battery voltage and time windows', 'Battery level and time windows']],
    discharge_control_type: [120, 0x0030, ['Battery voltage', 'Battery level', 'Both']],
    ongrid_eod_type: [120, 0x0040, ['Battery voltage', 'Battery level']],
    gen_charge_type: [120, 0x0080, ['Battery voltage', 'Battery level']],
    output_priority: [145, undefined, ['Battery first', 'Solar first', 'Grid first']],
    line_mode: [146, undefined, ['Appliance (APL)', 'UPS', 'Generator (GEN)']],
  };
  for (const [name, [address, mask, labels]] of Object.entries(table)) {
    const w = control(generic, name);
    assert.deepEqual([reg(w), w.kind, w.mask], [address, 'enum', mask], name);
    const d = s.descriptor(w);
    assert.equal(d.type, 'select');
    assert.deepEqual(d.allowed, labels.map((_, i) => i));
    assert.deepEqual(d.allowed.map(v => d.labels[v]), labels);
    for (const bad of [labels.length, -1, 1.5, '1', true]) assert.throws(() => s.encode(w, bad), `${name} ${bad}`);
  }
  // 0xE7: half-hour start on, AC charge by SOC (3), discharge by both (2), EOD by SOC, generator by SOC.
  const t = fake({ 120: 0x00E7 });
  const read = async name => (await s.read(t, control(generic, name))).value;
  assert.deepEqual([await read('ac_charge_type'), await read('discharge_control_type'), await read('ongrid_eod_type'), await read('gen_charge_type')], [3, 2, 1, 1]);
  const r = await s.change(t, control(generic, 'ac_charge_type'), 3, 5);
  assert.equal(r.status, 'verified'); assert.deepEqual(t.writes, [[120, 0x00EB]]);
  // Values the inverter holds but the documents don't name block the change.
  assert.equal((await s.read(fake({ 120: 0x000C }), control(generic, 'ac_charge_type'))).writable, false);
  assert.equal((await s.read(fake({ 145: 3 }), control(generic, 'output_priority'))).writable, false);
  assert.equal((await s.read(fake({ 145: 1 }), control(generic, 'output_priority'))).value, 1);
});

test('schedules are hour in the low byte, minute in the high byte', async () => {
  const windows = { charge_first: 76, forced_discharge: 84, ac_first: 152 };
  for (const [prefix, base] of Object.entries(windows)) {
    for (let n = 1; n <= 3; n++) {
      assert.equal(reg(control(generic, `${prefix}_start_time_${n}`)), base + (n - 1) * 2, `${prefix} ${n} start`);
      assert.equal(reg(control(generic, `${prefix}_end_time_${n}`)), base + (n - 1) * 2 + 1, `${prefix} ${n} end`);
      assert.equal(control(generic, `${prefix}_start_time_${n}`).kind, 'time');
    }
  }
  const w = control(generic, 'forced_discharge_start_time_1');
  const t = fake({ 84: 0x1E16 });
  assert.equal((await s.read(t, w)).value, '22:30');
  assert.equal((await s.change(t, w, '22:30', '06:05')).status, 'verified');
  assert.deepEqual(t.writes, [[84, 0x0506]]);
  assert.equal((await s.read(fake({ 76: 0x001E }), control(generic, 'charge_first_start_time_1'))).writable, false, 'hour 30');
});

test('family: generic-profile additions work on any LuxPower identity, GETA controls stay GETA-only', async () => {
  const t = fake({ 19: NOT_GETA, 101: 60, 64: 50 });
  const current = await s.read(t, control(generic, 'max_charge_current'));
  assert.equal(current.writable, true); assert.equal(current.identity.model.geta, false);
  assert.equal((await s.change(t, control(generic, 'max_charge_current'), 60, 70)).status, 'verified');
  assert.match((await s.read(t, control(generic, 'charge_power_percent'))).blockedReason, /GETA/);
  assert.equal((await s.change(t, control(generic, 'charge_power_percent'), 50, 60)).success, false);
  assert.match((await s.read(t, control(v24, 'max_charge_current'))).blockedReason, /GETA/);
  assert.equal((await s.read(fake({ 101: 60 }), control(v24, 'max_charge_current'))).writable, true);
  assert.deepEqual(t.writes, [[101, 70]]);
  const unreadable = fake(); unreadable.readRegisters = async () => { throw new Error('no reply'); };
  await assert.rejects(s.read(unreadable, control(generic, 'max_charge_current')), /no reply/);
  assert.match(s.descriptor(control(generic, 'max_charge_current')).blockedReason, /identity/);
});

test('the offline snapshot check handles selectors, byte fields and non-GETA identities', async () => {
  const { compare } = require('../scripts/verify-luxpower-snapshots');
  const t = fake({ 19: NOT_GETA, 120: 0x00E7, 83: 0x0314 });
  const dev = { name: 'test', profile: 'luxpower-geta', dongle_serial: 'DT00000001', inverter_serial: 'IN00000001' };
  const before = await s.snapshot(t, generic, dev);
  t.raw[120] = 0x00EB; t.raw[83] = 0x031E;
  const after = await s.snapshot(t, generic, dev);
  assert.equal(compare(before, after, 'ac_charge_type', '5').matched, true);
  assert.equal(compare(before, after, 'forced_discharge_soc_limit', '30').matched, true);
  assert.equal(compare(before, after, 'ac_charge_type', '4').matched, false);
  assert.throws(() => compare(before, after, 'charge_power_percent', '50'), /GETA/);
  assert.deepEqual(t.writes, []);
});

test('new registers decode with the integration\'s scales and signs', () => {
  const names = ['afci_current_ch1', 'afci_flag', 'afci_max_arc_ch4', 'grid_connect_time', 'grid_frequency_connect_low',
    'grid_voltage_limit_1_low', 'grid_voltage_limit_1_low_time', 'pf_cmd', 'ac_charge_soc_limit', 'charge_first_power_percent',
    'charge_first_soc_limit', 'forced_discharge_soc_limit', 'max_backflow_power_percent', 'lead_acid_charge_low_temp',
    'ptouser_start_discharge', 'ptouser_start_charge', 'ct_power_offset', 'charge_power_percent_precise',
    'output_priority', 'ac_charge_battery_current', 'max_grid_input_power', 'over_temp_derate_point',
    'forced_discharge_end_voltage', 'quick_charge_time', 'generator_cool_down_time', 'npe_threshold'];
  const byName = new Map(generic.metrics.map(m => [m.name, m]));
  const instance = { mappings: Object.fromEntries(names.map(n => { const m = byName.get(n); assert.ok(m, n); return [n, `${m.register_type}:${m.register}`]; })) };
  const words = {
    'input:140': 1234, 'input:144': 3, 'input:152': 77,
    'holding:23': 60, 'holding:27': 4750, 'holding:29': 1840, 'holding:31': 300, 'holding:62': 1000,
    'holding:67': 90, 'holding:74': 50, 'holding:75': 0x0264, 'holding:83': 0x0314, 'holding:103': 0,
    'holding:108': 0xFF38, 'holding:116': 50, 'holding:117': 0xFFCE, 'holding:119': 0xFFFF, 'holding:138': 955,
    'holding:145': 2, 'holding:168': 100, 'holding:176': 123, 'holding:199': 750, 'holding:202': 480,
    'holding:234': 1440, 'holding:237': 15, 'holding:242': 300,
  };
  const { metrics, units } = decodeLuxpowerMetrics(generic, instance, words);
  assert.deepEqual(metrics, {
    afci_current_ch1: 1234, afci_flag: 3, afci_max_arc_ch4: 77, grid_connect_time: 60, grid_frequency_connect_low: 47.5,
    grid_voltage_limit_1_low: 184, grid_voltage_limit_1_low_time: 300, pf_cmd: 1, ac_charge_soc_limit: 90, charge_first_power_percent: 50,
    charge_first_soc_limit: 100, forced_discharge_soc_limit: 20, max_backflow_power_percent: 0, lead_acid_charge_low_temp: -20,
    ptouser_start_discharge: 50, ptouser_start_charge: -50, ct_power_offset: -1, charge_power_percent_precise: 95.5,
    output_priority: 2, ac_charge_battery_current: 100, max_grid_input_power: 12.3, over_temp_derate_point: 75,
    forced_discharge_end_voltage: 48, quick_charge_time: 1440, generator_cool_down_time: 1.5, npe_threshold: 30,
  });
  assert.deepEqual([units.afci_current_ch1, units.grid_frequency_connect_low, units.max_grid_input_power, units.generator_cool_down_time],
    ['mA', 'Hz', 'kW', 'min']);
});

test('registers the integration itself flags as unresolved, packed or private are not added', () => {
  const holding = new Set(generic.metrics.filter(m => m.register_type === 'holding').map(reg));
  // 252 (W vs A), 260 (0.1 V vs V), 261 (one register, two meanings), 206/232 (W vs 0.1 kW), 183 (main count vs ms),
  // 136 (named over-frequency, described as under-frequency),
  // 16/132/235 (two values in one register), 225 (LCD password), 245 (flash size), 248-251 (WattNode meter setup).
  for (const r of [16, 132, 136, 183, 206, 225, 232, 235, 245, 248, 249, 250, 251, 252, 260, 261]) assert.ok(!holding.has(r), `holding ${r}`);
  assert.ok(!generic.metrics.some(m => m.register_type === 'input' && reg(m) >= 5000), 'per-battery block (5000+) not added');
});
