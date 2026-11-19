'use strict';
const checks = require('./_checks');
// Growatt SPH profile: rows against the register map it was built from, and decoded through the engine
// (input registers, 32-bit values high word first in units of 0.1).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { checkProfile } = require('../modules/profileCheck');
const { readRegisters } = require('../modules/modbusDecode');

const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'Growatt SPH hybrid (Modbus RTU).json'), 'utf8'));
const by = m => p.registers.find(r => r.metric === m);
assert.deepEqual(checkProfile(p), [], 'passes the checker with no findings');
assert.equal(p.connection, 'rtu'); assert.equal(p.function, 'input'); assert.equal(p.wordOrder, undefined, 'high word first');
assert.equal(p.status, 'unverified'); assert.match(p.source, /Growatt_ModbusTCP/);

const rows = [
  ['inverter_status', 0, 'uint16', 1, ''], ['pv_power', 1, 'uint32', 0.1, 'W'], ['pv1_voltage', 3, 'uint16', 0.1, 'V'], ['pv2_power', 9, 'uint32', 0.1, 'W'],
  ['grid_frequency', 37, 'uint16', 0.01, 'Hz'], ['inverter_power', 40, 'uint32', 0.1, 'W'], ['inverter_energy_total', 55, 'uint32', 0.1, 'kWh'],
  ['inverter_temp', 93, 'int16', 0.1, '°C'], ['battery_discharge_power', 1009, 'uint32', 0.1, 'W'], ['battery_charge_power', 1011, 'uint32', 0.1, 'W'],
  ['battery_voltage', 1013, 'uint16', 0.1, 'V'], ['battery_soc', 1014, 'uint16', 1, '%'], ['battery_temp', 1040, 'int16', 0.1, '°C'],
  ['grid_import_power', 1021, 'uint32', 0.1, 'W'], ['grid_export_power', 1029, 'int32', 0.1, 'W'], ['load_power', 1037, 'uint32', 0.1, 'W'],
  ['battery_charge_energy_total', 1058, 'uint32', 0.1, 'kWh'], ['load_energy_day', 1060, 'uint32', 0.1, 'kWh'], ['battery_current', 1088, 'int16', 0.01, 'A'], ['battery_soh', 1096, 'uint16', 1, '%'],
];
for (const [m, addr, type, scale, unit] of rows) {
  const r = by(m);
  assert.ok(r, m + ' is in the profile');
  assert.deepEqual([r.address, r.type, r.scale, r.unit], [addr, type, scale, unit], m);
}
const used = new Set();
for (const r of p.registers) { const w = { uint32: 2, int32: 2, uint64: 4 }[r.type] || 1; for (let i = 0; i < w; i++) { assert.ok(!used.has(r.address + i), `${r.metric} overlaps`); used.add(r.address + i); } }
assert.match(by('grid_export_power').note, /Positive means exporting/); assert.match(by('grid_export_energy_total').note, /disagreed/);

const words = {}; words[1] = 0x0000; words[2] = 0x3A98;      // 15000 x 0.1 = 1500 W
words[1029] = 0xFFFF; words[1030] = 0xEC78;                 // -5000 x 0.1 = -500 W (importing)
words[1014] = 64; words[1088] = 0xFF38; words[93] = 0xFFCE; words[55] = 0x0001; words[56] = 0x86A0;
(async () => {
  const calls = [];
  const dev = {
    async readInputRegisters(a, n) { calls.push([a, n]); return { data: Array.from({ length: n }, (_, i) => words[a + i] || 0) }; },
    async readHoldingRegisters() { throw new Error('this profile never reads holding registers'); },
  };
  const { values, failed } = await readRegisters(dev, p.registers, { function: p.function, wordOrder: p.wordOrder });
  assert.equal(failed.length, 0); assert.ok(calls.every(c => c[1] <= 32));
  assert.equal(values.pv_power, 1500); assert.equal(values.grid_export_power, -500); assert.equal(values.battery_soc, 64);
  assert.equal(values.battery_current, -2.0, 'a negative 16-bit current at 0.01 A'); assert.equal(values.inverter_temp, -5);
  assert.equal(values.inverter_energy_total, 10000, 'a 32-bit energy counter at 0.1 kWh');
  console.log('ok - Growatt SPH profile');
  checks.done();
})();
