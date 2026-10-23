'use strict';
const checks = require('./_checks');
// Several inverters of one kind: roles get totals across them, named from the
// reading (total_pv_power, average_battery_soc), and the wizard's energy
// metrics follow. Runs only when the set of inverters changes, grows with a
// third, and goes back to the one reading when only one is left.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-inverter-totals-')));
const { initializeDatabase, setConfig, getConfig } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const { profileNames } = require(path.join(REPO, 'modules/inverterNames'));
const { updateTotals, NOTE } = require(path.join(REPO, 'modules/inverterTotals'));

const names = profileNames('phocos-anygrid-ble');
const h = n => [...names].find(([, v]) => v === n)[0];
const inv = (n, enabled = true) => ({ name: `Inverter ${n}`, profile: 'phocos-anygrid-ble', transport: 'ble-gatt', enabled, prefix: `inv${n}_`,
  mappings: { [`inv${n}_pv_power`]: h('pv_power'), [`inv${n}_output_power`]: h('output_power'), [`inv${n}_battery_soc`]: h('battery_soc'), [`inv${n}_pv1_voltage`]: h('pv1_voltage') } });
const json = k => JSON.parse(getConfig(k));
const def = n => json('combined_metrics').find(d => d.name === n);

setConfig('dongle_config', JSON.stringify([inv(1)]));
setConfig('role_metrics', JSON.stringify({ solar: 'inv1_pv_power', consumption: 'inv1_output_power', battery_soc: 'inv1_battery_soc', solar_voltage: 'inv1_pv1_voltage', daily_solar: 'solar_energy_today' }));
setConfig('combined_metrics', JSON.stringify([{ id: 'w1', name: 'solar_energy_today', unit: 'kWh', enabled: true, fn: 'energy_today', inputs: ['inv1_pv_power'], input_unit: 'W', note: 'Added by the setup wizard' }]));
assert.deepEqual(updateTotals(), [], 'one inverter: nothing to add');
assert.equal(json('combined_metrics').length, 1);
console.log('ok - one inverter: roles keep its readings');

setConfig('dongle_config', JSON.stringify([inv(1), inv(2)]));
updateTotals();
assert.deepEqual(json('role_metrics'), { solar: 'total_pv_power', consumption: 'total_output_power', battery_soc: 'average_battery_soc', solar_voltage: 'inv1_pv1_voltage', daily_solar: 'solar_energy_today' },
  'power and battery roles use totals; voltage is not added up');
assert.deepEqual(def('total_pv_power').inputs, ['inv1_pv_power', 'inv2_pv_power']);
assert.equal(def('total_pv_power').fn, 'sum');
assert.deepEqual(def('total_pv_power').labels, { inv1_pv_power: 'Inverter 1', inv2_pv_power: 'Inverter 2' });
assert.equal(def('average_battery_soc').fn, 'mean');
assert.deepEqual(def('solar_energy_today').inputs, ['total_pv_power'], 'the wizard\'s daily energy counts both');
assert.ok(json('user_metrics').some(m => m.name === 'total_pv_power' && m.unit === 'W' && m.combined));
const cm = require(path.join(REPO, 'modules/combinedMetrics'));
const ok = []; for (const d of json('combined_metrics')) { assert.deepEqual(cm.validateDefinition(d, ok), [], d.name); ok.push(d); }
console.log('ok - two inverters: totals named from the readings, roles and daily energy use them');

assert.equal(updateTotals(), null, 'same inverters: nothing to do');
setConfig('role_metrics', JSON.stringify({ ...json('role_metrics'), solar: 'inv1_pv_power' }));
setConfig('dongle_config', JSON.stringify([inv(2), inv(1)]));
assert.equal(updateTotals(), null);
assert.equal(json('role_metrics').solar, 'inv1_pv_power', 'a role changed by hand afterwards stays');
console.log('ok - runs only when the inverters change; later hand changes stay');

setConfig('role_metrics', JSON.stringify({ ...json('role_metrics'), solar: 'total_pv_power' }));
setConfig('dongle_config', JSON.stringify([inv(1), inv(2), inv(3)]));
updateTotals();
assert.deepEqual(def('total_pv_power').inputs, ['inv1_pv_power', 'inv2_pv_power', 'inv3_pv_power']);
assert.equal(json('combined_metrics').filter(d => d.name === 'total_pv_power').length, 1);
console.log('ok - a third inverter joins the totals');

setConfig('dongle_config', JSON.stringify([inv(1), inv(2, false), inv(3, false)]));
updateTotals();
assert.equal(json('role_metrics').solar, 'inv1_pv_power');
assert.equal(json('role_metrics').battery_soc, 'inv1_battery_soc');
assert.deepEqual(def('solar_energy_today').inputs, ['inv1_pv_power']);
assert.equal(def('total_pv_power').enabled, false);
console.log('ok - back to one inverter: its readings again, totals switched off');

setConfig('combined_metrics', JSON.stringify([{ id: 'u1', name: 'total_pv_power', unit: 'W', enabled: true, fn: 'max', inputs: ['inv1_pv_power', 'other'] }]));
setConfig('dongle_config', JSON.stringify([inv(1), inv(2)]));
updateTotals();
assert.equal(json('role_metrics').solar, 'inv1_pv_power', 'a combined metric of the user\'s own with that name is left alone');
assert.deepEqual(def('total_pv_power'), { id: 'u1', name: 'total_pv_power', unit: 'W', enabled: true, fn: 'max', inputs: ['inv1_pv_power', 'other'] });
assert.equal(json('role_metrics').consumption, 'total_output_power');
assert.equal(def('total_output_power').note, NOTE);
console.log('ok - a name already used by the user\'s own combined metric is not taken over');
checks.done();
