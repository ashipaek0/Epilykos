'use strict';
const checks = require('./_checks');
// Huawei SUN2000 profile: rows checked against Huawei's register definitions (V3.0), and decoded through the engine.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { checkProfile } = require('../modules/profileCheck');
const { readRegisters } = require('../modules/modbusDecode');

const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'Huawei SUN2000 (Modbus TCP).json'), 'utf8'));
const by = m => p.registers.find(r => r.metric === m);
assert.deepEqual(checkProfile(p), [], 'passes the checker with no findings');
assert.equal(p.connection, 'tcp'); assert.equal(p.status, 'unverified'); assert.match(p.source, /Modbus Interface Definitions/);
assert.equal(p.function, undefined); assert.equal(p.wordOrder, undefined, 'holding registers, high word first');

const rows = [   // [metric, address, type, scale, unit] (the document's gain 10 is a scale of 0.1)
  ['pv1_voltage', 32016, 'int16', 0.1, 'V'], ['pv1_current', 32017, 'int16', 0.01, 'A'], ['pv4_current', 32023, 'int16', 0.01, 'A'],
  ['pv_power', 32064, 'int32', 1, 'W'], ['inverter_voltage_a', 32069, 'uint16', 0.1, 'V'], ['inverter_current_a', 32072, 'int32', 0.001, 'A'],
  ['inverter_power', 32080, 'int32', 1, 'W'], ['power_factor', 32084, 'int16', 0.001, ''], ['grid_frequency', 32085, 'uint16', 0.01, 'Hz'],
  ['inverter_temp', 32087, 'int16', 0.1, '°C'], ['device_status', 32089, 'uint16', 1, ''], ['pv_energy_total', 32106, 'uint32', 0.01, 'kWh'], ['pv_energy_day', 32114, 'uint32', 0.01, 'kWh'],
  ['battery_soc', 37760, 'uint16', 0.1, '%'], ['battery_voltage', 37763, 'uint16', 0.1, 'V'], ['battery_current', 37764, 'int16', 0.1, 'A'], ['battery_power', 37765, 'int32', 1, 'W'],
  ['battery_charge_energy_total', 37780, 'uint32', 0.01, 'kWh'], ['battery_discharge_energy_day', 37786, 'uint32', 0.01, 'kWh'],
  ['grid_power', 37113, 'int32', 1, 'W'], ['grid_export_energy_total', 37119, 'int32', 0.01, 'kWh'], ['grid_import_energy_total', 37121, 'int32', 0.01, 'kWh'],
];
for (const [m, addr, type, scale, unit] of rows) {
  const r = by(m);
  assert.ok(r, m + ' is in the profile');
  assert.deepEqual([r.address, r.type, r.scale, r.unit], [addr, type, scale, unit], m);
}
const used = new Set();
for (const r of p.registers) { const w = { uint32: 2, int32: 2, uint64: 4 }[r.type] || 1; for (let i = 0; i < w; i++) { assert.ok(!used.has(r.address + i), `${r.metric} overlaps`); used.add(r.address + i); } }
assert.match(by('battery_power').note, /Positive means charging/); assert.match(by('grid_power').note, /feeding the grid/);

const words = {}; words[32064] = 0x0000; words[32065] = 0x1388; words[32016] = 7512; words[37765] = 0xFFFF; words[37766] = 0xF448; words[37760] = 873; words[37113] = 0xFFFF; words[37114] = 0xFE0C; words[32017] = 0xFFFF;
(async () => {
  const dev = { async readHoldingRegisters(a, n) { return { data: Array.from({ length: n }, (_, i) => words[a + i] || 0) }; }, async readInputRegisters() { throw new Error('not used'); } };
  const { values, failed } = await readRegisters(dev, p.registers);
  assert.equal(failed.length, 0);
  assert.equal(values.pv_power, 5000); assert.equal(values.pv1_voltage, 751.2); assert.equal(values.battery_soc, 87.3);
  assert.equal(values.battery_power, -3000, 'a negative 32-bit value'); assert.equal(values.grid_power, -500); assert.equal(values.pv1_current, -0.01, 'a negative 16-bit value');
  console.log('ok - Huawei SUN2000 profile');
  checks.done();
})();
