'use strict';
const checks = require('./_checks');
/**
 * Bluetooth and wired BMS mapping rows, Tuya data point rows, and the Modbus, RS-232 and dongle profile rows have the "+" (new metric) control the inverter,
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

const catalog = fs.readFileSync(path.join(__dirname, '..', 'public/js/catalog-ui.js'), 'utf8');
const helper = section('const bmsAdapter =', 'function renderBmsWiredMappings(');
assert.match(helper, /createInlineMetricControl\(adapter, row, metricSelect/);
assert.match(helper, /addNewMetricControl\(bmsAdapter, row, metricSelect, entity\)/, 'BMS rows use the shared helper with the BMS adapter');
assert.match(helper, /row\.style\.flexWrap = 'wrap'/, 'the editor gets a line of its own');
assert.match(helper, /entity && entity\.unit/, 'unit is prefilled when the BMS reports one');

// Tuya data point rows have it too (the unit is left to the person: a data point carries none).
const tuyaRow = section('function addTuyaDpRow(', 'function reindexTuya(');
assert.match(tuyaRow, /row\.appendChild\(removeBtn\);\s*\n\s*addNewMetricControl\(tuyaAdapter, row, metricSelect, null\);/, 'a Tuya DP row gets the + New control');
assert.match(js, /const tuyaAdapter = \{ defaultUnit\(\) \{ return ''; \} \};/);
assert.match(catalog, /metricSelect\.after\(btn\);\s*\n\s*row\.appendChild\(panel\);/, 'on every row the + sits right beside the dropdown');

// So do the Modbus, RS-232 and dongle profile rows, with the unit the profile gives the field.
for (const [fn, next, call] of [
  ['function renderModbusMappings(', '// ── RS232 Field Mapping Helpers', /addNewMetricControl\(registerAdapter, row, metricSelect, reg\)/],
  ['function renderRs232Mappings(', 'let rs232DeviceCounter = 0;', /addNewMetricControl\(registerAdapter, row, metricSelect, info\)/],
  ['function renderDongleMappings(', '// ---------- LuxPower TCP entity-catalog', /addNewMetricControl\(registerAdapter, row, metricSelect, \{ unit: unitMap\[key\] \}\)/]
]) assert.match(section(fn, next), call, `${fn} rows get the + control`);
assert.match(js, /const registerAdapter = bmsAdapter;/);
assert.match(catalog, /btn\.textContent = '\+';\s*\n\s*btn\.setAttribute\('aria-label', 'New metric'\);/, 'a plain + that still has a name for screen readers');

assert.match(js, /\|\| row\.dataset\.bmsKey\n/, 'a BMS row counts as mapped when it has a metric');
assert.match(js, /'bms-devices-container', 'bms-wired-devices-container'\]\.forEach/, 'the note follows changes on BMS cards');
console.log('ok - BMS mapping rows: + New control, unit from the BMS field, save note counts them');
checks.done();
