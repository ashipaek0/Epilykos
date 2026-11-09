'use strict';
const checks = require('./_checks');
/**
 * Battery readings carry their unit, so a bank's total of stored energy (Wh) is
 * shown as 1.03 kWh and not 1,026 kWh:
 * - known BMS keys are stored with their unit (cycle_capacity is Wh), raw and mapped;
 * - a bank result keeps the unit of what it adds up, a weighted charge level is %,
 *   the remaining Ah of sum_weighted is Ah, and on/off results have none;
 * - the card formatter then shows 1026 Wh as 1.03 kWh, from the unit the metric carries.
 */
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('node:url');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-bmsunits-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.BMS_BRIDGE_URL;

const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const bms = require('../modules/bms');
const agg = require('../modules/bmsAggregator');
const { unitOfBmsKey, unitOfBankFunction } = require('../modules/bmsUnits');
const { getCurrentMetrics } = require('../modules/metrics');
const now = () => Math.floor(Date.now() / 1000);
const put = (metric, value) => db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run(metric, value, now());

(async () => {
  // The units of the keys.
  assert.deepEqual(['cycle_capacity', 'design_capacity', 'cycle_charge', 'battery_level', 'voltage', 'current', 'power', 'temperature'].map(unitOfBmsKey),
    ['Wh', 'Ah', 'Ah', '%', 'V', 'A', 'W', '°C']);
  assert.equal(unitOfBmsKey('cycles'), undefined, 'a count has no unit');
  assert.equal(unitOfBmsKey('made_up'), undefined, 'and an unknown key is not guessed');
  assert.equal(unitOfBmsKey('constructor'), undefined, 'nor an object property');
  console.log('ok - BMS keys have their units');

  // A reading is stored with it, under the raw name and a mapped one.
  bms.storeSample({ name: '300Ah', mappings: { cycle_capacity: 'Battery energy' } }, { cycle_capacity: 786, cycles: 12, battery_level: 80 }, now());
  database.flushMetrics();
  const m = getCurrentMetrics();
  assert.equal(m.bms_300Ah_cycle_capacity.unit, 'Wh');
  assert.equal(m['Battery energy'].unit, 'Wh', 'the mapped name too');
  assert.equal(m.bms_300Ah_battery_level.unit, '%');
  assert.equal(m.bms_300Ah_cycles.unit, null);
  console.log('ok - readings are stored with their unit');

  // A bank keeps the unit of what it adds up.
  database.setConfig('bms_devices', JSON.stringify([{ name: '300Ah', enabled: true, address: 'AA:BB:CC:DD:EE:01', mappings: {} }, { name: '135Ah', enabled: true, address: 'AA:BB:CC:DD:EE:02', mappings: {} }]));
  put('bms_300Ah_cycle_capacity', 786); put('bms_135Ah_cycle_capacity', 240);
  put('bms_300Ah_battery_level', 80); put('bms_135Ah_battery_level', 60);
  put('bms_300Ah_design_capacity', 300); put('bms_135Ah_design_capacity', 135);
  put('bms_300Ah_chrg_mosfet', 1); put('bms_135Ah_chrg_mosfet', 0);
  const bank = { name: 'Bank', enabled: true, devices: [{ name: '300Ah' }, { name: '135Ah' }], functions: [
    { output: 'stored_energy', fn: 'sum', source: 'cycle_capacity' },
    { output: 'soc', fn: 'weighted_soc', source: 'battery_level' },
    { output: 'remaining_ah', fn: 'sum_weighted', source: 'battery_level' },
    { output: 'any_charging', fn: 'or', source: 'chrg_mosfet' },
    { output: 'per_battery', fn: 'sum', sources: { '300Ah': 'cycle_capacity', '135Ah': 'cycle_capacity' } },
    { output: 'mixed', fn: 'sum', sources: { '300Ah': 'cycle_capacity', '135Ah': 'design_capacity' } }] };
  await agg.computeBankAggregates(bank, 30);
  database.flushMetrics();
  const b = getCurrentMetrics();
  assert.equal(b.bank_stored_energy.value, 1026);
  assert.equal(b.bank_stored_energy.unit, 'Wh', 'a total of Wh readings stays in Wh');
  assert.equal(b.bank_soc.unit, '%');
  assert.equal(b.bank_remaining_ah.unit, 'Ah');
  assert.equal(b.bank_any_charging.unit, null, 'an on/off result has none');
  assert.equal(b.bank_per_battery.unit, 'Wh', 'a key per battery that agrees');
  assert.equal(b.bank_mixed.unit, null, 'and none when they do not');
  assert.equal(b.bank_Bank_devices_online.unit, null);
  assert.deepEqual([unitOfBankFunction({ fn: 'mean', source: 'voltage' }), unitOfBankFunction({ fn: 'max', source: 'temperature' })], ['V', '°C']);
  console.log('ok - a bank result keeps the unit of what it adds up');

  // So the card shows it as kWh from 1000 Wh up: 1.03 kWh, not 1,026 kWh.
  const { formatEntry } = await import(pathToFileURL(path.join(REPO, 'public/js/components/format.js')).href);
  const shown = formatEntry(b.bank_stored_energy, '', 'bank_stored_energy');
  assert.equal(shown.text.replace(/,/g, '.'), '1.03 kWh');
  assert.equal(formatEntry({ value: 786, unit: 'Wh' }, '', 'bms_300Ah_cycle_capacity').text, '786 Wh', 'under 1000 stays in Wh');
  assert.equal(formatEntry({ value: 1026, unit: null }, '', 'bank_energy_total').unit, 'kWh', 'with no unit the name was guessed: that is what showed 1,026 kWh');
  console.log('ok - the card shows the total as kWh');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
