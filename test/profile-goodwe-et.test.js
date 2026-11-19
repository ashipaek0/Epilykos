'use strict';
const checks = require('./_checks');
// GoodWe ET/EH/BT/BH profile: spot checks against the rows of GoodWe's "GW Third-Party EMS Protocol MODBUS" (v1.2).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { checkProfile } = require('../modules/profileCheck');
const { readRegisters } = require('../modules/modbusDecode');

const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'GoodWe ET hybrid (Modbus RTU).json'), 'utf8'));
const by = m => p.registers.find(r => r.metric === m);
assert.deepEqual(checkProfile(p), [], 'passes the checker with no findings');
assert.equal(p.connection, 'rtu'); assert.equal(p.defaultUnitId, 247, '247 is the factory unit address in the document');
assert.equal(p.status, 'unverified'); assert.match(p.source, /Third-Party EMS Protocol/);
assert.equal(p.function, undefined, 'the document reads with function 03'); assert.equal(p.wordOrder, undefined, 'high word first');

// [metric, address, type, scale, unit] straight from the document's rows
const rows = [
  ['pv1_voltage', 35103, 'uint16', 0.1, 'V'], ['pv1_current', 35104, 'uint16', 0.1, 'A'], ['pv1_power', 35105, 'uint32', 1, 'W'],
  ['pv2_power', 35109, 'uint32', 1, 'W'], ['inverter_frequency_r', 35123, 'uint16', 0.01, 'Hz'], ['inverter_power_r', 35124, 'int32', 1, 'W'],
  ['grid_power', 35139, 'int32', 1, 'W'], ['load_power', 35171, 'int32', 1, 'W'], ['backup_load_power', 35169, 'int32', 1, 'W'],
  ['inverter_heatsink_temp', 35176, 'int16', 0.1, '°C'], ['battery_voltage', 35180, 'uint16', 0.1, 'V'], ['battery_current', 35181, 'int16', 0.1, 'A'],
  ['battery_power', 35182, 'int32', 1, 'W'], ['work_mode', 35187, 'uint16', 1, ''], ['pv_energy_total', 35191, 'uint32', 0.1, 'kWh'],
  ['pv_energy_day', 35193, 'uint32', 0.1, 'kWh'], ['grid_export_energy_day', 35199, 'uint16', 0.1, 'kWh'], ['grid_import_energy_day', 35202, 'uint16', 0.1, 'kWh'],
  ['load_energy_total', 35203, 'uint32', 0.1, 'kWh'], ['battery_charge_energy_total', 35206, 'uint32', 0.1, 'kWh'], ['battery_discharge_energy_day', 35211, 'uint16', 0.1, 'kWh'],
  ['meter_total_active_power', 36008, 'int16', 1, 'W'], ['battery_temp', 37003, 'uint16', 0.1, '°C'], ['battery_soc', 37007, 'uint16', 1, '%'], ['battery_soh', 37008, 'uint16', 1, '%'],
];
for (const [m, addr, type, scale, unit] of rows) {
  const r = by(m);
  assert.ok(r, m + ' is in the profile');
  assert.deepEqual([r.address, r.type, r.scale, r.unit], [addr, type, scale, unit], m);
}
// The first word of a pair is where the profile points, and nothing else is listed inside it.
const used = new Set();
for (const r of p.registers) { const w = { uint32: 2, int32: 2, uint64: 4 }[r.type] || 1; for (let i = 0; i < w; i++) { assert.ok(!used.has(r.address + i), `${r.metric} overlaps`); used.add(r.address + i); } }
// The two signs the document does not state are flagged for the person testing.
assert.match(by('battery_power').note, /does not state the sign/); assert.match(by('grid_power').note, /does not state the sign/);

// Decoding with the engine: a discharging battery's 32-bit power, a PV pair above 65535, and a negative current.
const words = {}; words[35182] = 0xFFFF; words[35183] = 0xF448; words[35105] = 0x0001; words[35106] = 0x86A0; words[35181] = 0xFF9C; words[37007] = 87;
(async () => {
  const dev = { async readHoldingRegisters(a, n) { return { data: Array.from({ length: n }, (_, i) => words[a + i] || 0) }; }, async readInputRegisters() { throw new Error('not used'); } };
  const { values, failed } = await readRegisters(dev, p.registers);
  assert.equal(failed.length, 0);
  assert.equal(values.battery_power, -3000); assert.equal(values.pv1_power, 100000); assert.equal(values.battery_current, -10); assert.equal(values.battery_soc, 87);
  console.log('ok - GoodWe ET profile');
  checks.done();
})();
