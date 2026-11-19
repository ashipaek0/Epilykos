'use strict';
const checks = require('./_checks');
// Sungrow SH profile: rows against the register list it was built from, and decoded through the engine
// (input registers, low word first).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { checkProfile } = require('../modules/profileCheck');
const { readRegisters } = require('../modules/modbusDecode');

const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'Sungrow SH hybrid (Modbus TCP).json'), 'utf8'));
const by = m => p.registers.find(r => r.metric === m);
assert.deepEqual(checkProfile(p), [], 'passes the checker with no findings');
assert.equal(p.connection, 'tcp'); assert.equal(p.function, 'input', 'read with function 04'); assert.equal(p.wordOrder, 'lsw_first');
assert.equal(p.status, 'unverified'); assert.match(p.source, /mkaiser/);

const rows = [
  ['inverter_temp', 5007, 'int16', 0.1, '°C'], ['pv1_voltage', 5010, 'uint16', 0.1, 'V'], ['pv4_current', 5115, 'uint16', 0.1, 'A'],
  ['pv_power', 5016, 'uint32', 1, 'W'], ['power_factor', 5034, 'int16', 0.001, ''], ['battery_power', 5213, 'int32', 1, 'W'],
  ['grid_frequency', 5241, 'uint16', 0.01, 'Hz'], ['grid_power', 5600, 'int32', 1, 'W'], ['battery_current', 5630, 'int16', 0.1, 'A'],
  ['backup_load_power', 5725, 'int32', 1, 'W'], ['pv_energy_day', 13001, 'uint16', 0.1, 'kWh'], ['pv_energy_total', 13002, 'uint32', 0.1, 'kWh'],
  ['load_power', 13007, 'int32', 1, 'W'], ['battery_voltage', 13019, 'uint16', 0.1, 'V'], ['battery_soc', 13022, 'uint16', 0.1, '%'],
  ['battery_soh', 13023, 'uint16', 0.1, '%'], ['battery_temp', 13024, 'int16', 0.1, '°C'], ['battery_discharge_energy_total', 13026, 'uint32', 0.1, 'kWh'],
  ['inverter_power', 13033, 'int32', 1, 'W'], ['grid_import_energy_total', 13036, 'uint32', 0.1, 'kWh'], ['grid_export_energy_total', 13045, 'uint32', 0.1, 'kWh'],
];
for (const [m, addr, type, scale, unit] of rows) {
  const r = by(m);
  assert.ok(r, m + ' is in the profile');
  assert.deepEqual([r.address, r.type, r.scale, r.unit], [addr, type, scale, unit], m);
}
const used = new Set();
for (const r of p.registers) { const w = { uint32: 2, int32: 2, uint64: 4 }[r.type] || 1; for (let i = 0; i < w; i++) { assert.ok(!used.has(r.address + i), `${r.metric} overlaps`); used.add(r.address + i); } }
assert.match(by('battery_power').note, /sign convention is not stated/); assert.match(by('grid_power').note, /sign convention is not stated/);

const words = {};
words[5213] = 0xF448; words[5214] = 0xFFFF;     // -3000 W, low word first
words[5016] = 0x86A0; words[5017] = 0x0001;     // 100000 W
words[13022] = 874; words[5007] = 0xFFEC; words[13002] = 0x0010; words[13003] = 0x0000;
(async () => {
  const calls = [];
  const dev = {
    async readInputRegisters(a, n) { calls.push(['i', a, n]); return { data: Array.from({ length: n }, (_, i) => words[a + i] || 0) }; },
    async readHoldingRegisters() { throw new Error('this profile never reads holding registers'); },
  };
  const { values, failed } = await readRegisters(dev, p.registers, { function: p.function, wordOrder: p.wordOrder });
  assert.equal(failed.length, 0); assert.ok(calls.length >= 1 && calls.every(c => c[2] <= 32));
  assert.equal(values.battery_power, -3000); assert.equal(values.pv_power, 100000); assert.equal(values.battery_soc, 87.4);
  assert.equal(values.inverter_temp, -2, 'a negative 16-bit temperature'); assert.equal(values.pv_energy_total, 1.6);
  console.log('ok - Sungrow SH profile');
  checks.done();
})();
