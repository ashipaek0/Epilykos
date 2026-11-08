'use strict';
const checks = require('./_checks');
/**
 * Bluetooth and wired BMS mapping rows have the "+ New" control the inverter,
 * Home Assistant and MQTT rows have, so a metric can be created where it is
 * mapped; and the "Save will persist N of M mapped" note counts BMS rows.
 */
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const js = fs.readFileSync(path.join(__dirname, '..', 'public/settings.js'), 'utf8');

const section = (from, to) => { const a = js.indexOf(from), b = js.indexOf(to, a); assert.ok(a >= 0 && b > a, `${from} found`); return js.slice(a, b); };
const ble = section('function renderBmsMappings(', '\n}\n');
const wired = section('function renderBmsWiredMappings(', 'function collectBmsWiredConfig');

for (const [name, src] of [['Bluetooth', ble], ['wired', wired]]) {
  assert.match(src, /addBmsNewMetricControl\(row, metricSelect, removeBtn, /, `${name} BMS rows get the + New control`);
  assert.match(src, /updateMappingSaveNote\(container\.closest\('\.device-card'\)\)/, `${name} BMS list keeps the save note`);
  assert.match(src, /const card = row\.closest\('\.device-card'\);\s+row\.remove\(\);[\s\S]*updateMappingSaveNote\(card\)/, `${name} remove button refreshes the note`);
}
assert.match(wired, /addBmsNewMetricControl\(row, metricSelect, removeBtn, info\)/, 'a wired BMS field gives its unit to the new metric');

const helper = section('const bmsAdapter =', 'function renderBmsWiredMappings(');
assert.match(helper, /createInlineMetricControl\(bmsAdapter, row, metricSelect/);
assert.match(helper, /row\.style\.flexWrap = 'wrap'/, 'the editor gets a line of its own');
assert.match(helper, /entity && entity\.unit/, 'unit is prefilled when the BMS reports one');

assert.match(js, /\|\| row\.dataset\.bmsKey\n/, 'a BMS row counts as mapped when it has a metric');
assert.match(js, /'bms-devices-container', 'bms-wired-devices-container'\]\.forEach/, 'the note follows changes on BMS cards');
console.log('ok - BMS mapping rows: + New control, unit from the BMS field, save note counts them');
checks.done();
