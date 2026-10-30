'use strict';
const checks = require('./_checks');
// Voltronic / Phocos QPIGS replies carry real decimals ("51.20", "50.0"); the
// profile must not scale them again. Uses the decoder from modules/rs232.js
// as it is, on replies in the formats of Phocos's RS-232 document (section
// 5.9) and of an Axpert.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../modules/rs232.js'), 'utf8');
const start = src.indexOf('function decodeAsciiResponse'), end = src.indexOf('function decodeVedirectFrame');
assert.ok(start > 0 && end > start, 'decodeAsciiResponse is where the test expects');
const decodeAsciiResponse = new Function(src.slice(start, end) + '; return decodeAsciiResponse;')();
const profile = require('../profiles/rs232/voltronic-qpigs.json');
const qpigs = profile.commands.find(c => c.name === 'QPIGS');
const decode = reply => decodeAsciiResponse(Buffer.from(reply), qpigs, null);
const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-9, `${what}: got ${got}, want ${want}`);

// Phocos Any-Grid PSW-H: AAA.A BB.B CCC.C DD.D EEEE FFFF GGG HHH II.II JJJ KKK LLLL MM.M NNN.N OO.OO PPPPP b7..b0 …
const phocos = decode('(230.0 50.0 231.5 50.1 0450 0380 009 380 51.20 004 075 0035 07.6 120.5 51.18 00008 00010110 00 00 01230 010 0 00 0000\r');
for (const [metric, want] of Object.entries({ grid_voltage: 230, grid_frequency: 50, output_voltage: 231.5, output_frequency: 50.1, output_va: 450, output_power: 380, load_percent: 9, bus_voltage: 380, battery_voltage: 51.2, battery_charge_current: 4, battery_soc: 75, inverter_temp: 35, pv_current: 7.6, pv_voltage: 120.5, battery_scc_voltage: 51.18, battery_discharge_current: 8 })) near(phocos[metric], want, 'Phocos ' + metric);
console.log('ok - a Phocos QPIGS reply decodes to the values it carries');

// Axpert / MPP Solar style reply.
const axpert = decode('(000.0 00.0 230.0 50.0 0161 0119 003 460 57.50 012 100 0069 0014 103.8 57.45 00000 00110110 00 00 00856 010\r');
for (const [metric, want] of Object.entries({ grid_voltage: 0, output_voltage: 230, output_frequency: 50, bus_voltage: 460, battery_voltage: 57.5, battery_soc: 100, pv_voltage: 103.8, battery_scc_voltage: 57.45 })) near(axpert[metric], want, 'Axpert ' + metric);
console.log('ok - an Axpert QPIGS reply decodes the same way');

// Frequencies in range, voltages not divided down.
for (const out of [phocos, axpert]) {
  assert.ok(out.output_frequency >= 45 && out.output_frequency <= 65, 'a mains frequency, not 0.5 Hz');
  assert.ok(out.battery_voltage >= 20, 'a battery voltage, not a tenth of one');
}
const scaled = qpigs.fields.filter(f => f.scale && f.scale !== 1).map(f => f.metric);
assert.deepEqual(scaled, [], 'no QPIGS field is scaled: the reply already has its decimals');
console.log('ok - no QPIGS field is divided again');
checks.done();
