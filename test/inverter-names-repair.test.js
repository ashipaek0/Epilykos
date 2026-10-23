'use strict';
const checks = require('./_checks');
// Inverter readings saved without their prefix (inv1battery_soc, or a second
// inverter's bare battery_soc) are renamed under it, with their history and
// every setting that names them. Names chosen by hand, role names and history
// field names in charts are left alone; a second run changes nothing.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-inverter-names-')));
const { initializeDatabase, getDb, setConfig, getConfig } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const { planRepair, repairSavedNames, profileNames } = require(path.join(REPO, 'modules/inverterNames'));

const names = profileNames('phocos-anygrid-ble');
assert.ok(names && names.size > 20, 'reads the profile handle -> name list');
const handleOf = n => [...names].find(([, v]) => v === n)[0];
const soc = handleOf('battery_soc'), pv = handleOf('pv_power'), load = handleOf('output_power');

const inv1 = { name: 'Inverter 1', profile: 'phocos-anygrid-ble', transport: 'ble-gatt', prefix: 'inv1_',
  mappings: { inv1battery_soc: soc, inv1pv_power: pv, house_load: load } };          // loose prefix; one hand-picked name
const inv2 = { name: 'Inverter 2', profile: 'phocos-anygrid-ble', transport: 'ble-gatt', prefix: 'inv2_',
  mappings: { battery_soc: soc, pv_power: pv, inv2_output_power: load } };          // bare names; one already right
setConfig('dongle_config', JSON.stringify([inv1, inv2]));
setConfig('role_metrics', JSON.stringify({ battery_soc: 'inv1battery_soc', solar: 'inv1pv_power', consumption: 'house_load' }));
setConfig('combined_metrics', JSON.stringify([{ id: 'c1', name: 'pv_total', fn: 'sum', inputs: ['inv1pv_power', 'pv_power'] }]));
setConfig('user_metrics', JSON.stringify([{ name: 'battery_soc', unit: '%' }, { name: 'inv1pv_power', unit: 'W' }]));
setConfig('notification_rules', JSON.stringify([{ id: 'r1', metric: 'battery_soc', op: '<', value: 20 }]));
setConfig('pvoutput_config', JSON.stringify({ enabled: true, metric_map: { v2: 'inv1pv_power' } }));
setConfig('dashboard_layouts', JSON.stringify([{ id: 'main', layout: [
  { type: 'metric-card', config: { metric: 'pv_power' } },
  { type: 'chart-power', config: { datasets: [{ metric: 'battery_soc' }] } },                 // a history field in a chart
  { type: 'system-overview', config: { metrics: { battery_soc: 'inv1battery_soc' } } }]}]));
setConfig('grid_status_entity', 'pv_power');
setConfig('metric_sanity_deny', 'inv1pv_power, other');

const ins = db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)');
for (let t = 0; t < 10; t++) { ins.run(1000 + t, 'inv1battery_soc', 50 + t); ins.run(1000 + t, 'battery_soc', 70 + t); }
db.prepare('INSERT INTO metrics_5m(bucket_start, metric, value_avg, value_min, value_max, value_count) VALUES (900, ?, 1, 1, 1, 1)').run('battery_soc');
db.prepare('INSERT INTO latest_metrics(metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('battery_soc', 79, 1009, '%');
db.prepare('INSERT INTO latest_metrics(metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('inv2_battery_soc', 1, 5, '%');   // older

// Planning alone changes nothing, and another source writing a name keeps its readings.
const plan = planRepair([inv1, inv2], new Set(['pv_power']));
assert.deepEqual(plan.renames.map(r => r.join('>')).sort(),
  ['battery_soc>inv2_battery_soc', 'inv1battery_soc>inv1_battery_soc', 'inv1pv_power>inv1_pv_power', 'pv_power>inv2_pv_power']);
assert.ok(!plan.moveData.has('pv_power') && plan.moveData.has('battery_soc'));
assert.equal(JSON.parse(getConfig('dongle_config'))[1].mappings.battery_soc, soc);
console.log('ok - plan: only bare or loose-prefix profile names; hand-picked and correct names stay');

const r = repairSavedNames();
assert.equal(r.renames.length, 4);
const dc = JSON.parse(getConfig('dongle_config'));
assert.deepEqual(Object.keys(dc[0].mappings).sort(), ['house_load', 'inv1_battery_soc', 'inv1_pv_power']);
assert.deepEqual(Object.keys(dc[1].mappings).sort(), ['inv2_battery_soc', 'inv2_output_power', 'inv2_pv_power']);
const count = n => db.prepare('SELECT COUNT(*) n FROM metrics WHERE metric = ?').get(n).n;
assert.equal(count('inv1_battery_soc'), 10); assert.equal(count('inv2_battery_soc'), 10);
assert.equal(count('inv1battery_soc') + count('battery_soc'), 0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM metrics_5m WHERE metric = 'inv2_battery_soc'").get().n, 1);
assert.deepEqual(db.prepare("SELECT value, timestamp FROM latest_metrics WHERE metric = 'inv2_battery_soc'").get(), { value: 79, timestamp: 1009 });
assert.equal(db.prepare("SELECT COUNT(*) n FROM latest_metrics WHERE metric = 'battery_soc'").get().n, 0);
console.log('ok - readings, 5-minute summaries and the newest latest value move with the name');

assert.deepEqual(JSON.parse(getConfig('role_metrics')), { battery_soc: 'inv1_battery_soc', solar: 'inv1_pv_power', consumption: 'house_load' }, 'role names (keys) stay');
assert.deepEqual(JSON.parse(getConfig('combined_metrics'))[0].inputs, ['inv1_pv_power', 'inv2_pv_power']);
assert.deepEqual(JSON.parse(getConfig('user_metrics')).map(u => u.name), ['inv2_battery_soc', 'inv1_pv_power']);
assert.equal(JSON.parse(getConfig('notification_rules'))[0].metric, 'inv2_battery_soc');
assert.equal(JSON.parse(getConfig('pvoutput_config')).metric_map.v2, 'inv1_pv_power');
const layout = JSON.parse(getConfig('dashboard_layouts'))[0].layout;
assert.equal(layout[0].config.metric, 'inv2_pv_power');
assert.equal(layout[1].config.datasets[0].metric, 'battery_soc', 'a chart naming a history field is left alone');
assert.deepEqual(layout[2].config.metrics, { battery_soc: 'inv1_battery_soc' });
assert.equal(getConfig('grid_status_entity'), 'inv2_pv_power');
assert.deepEqual(JSON.parse(getConfig('metric_sanity_deny')), ['inv1_pv_power', 'other']);
console.log('ok - every setting naming them follows; role keys and chart history fields stay');

assert.equal(repairSavedNames(), null, 'nothing left to repair');
assert.equal(planRepair([{ ...inv1, prefix: '' }]).renames.length, 0, 'no prefix: bare names are right');
assert.equal(planRepair([{ ...inv1, profile: 'no-such-profile' }]).renames.length, 0, 'unknown profile: left alone');
console.log('ok - a second run, an inverter without a prefix and an unknown profile change nothing');

const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
assert.match(server, /updateInverterMetrics\(\);\n\s*startExternalPolling\(\); startBmsPolling\(\); startBmsWiredPolling\(\); startDonglePolling\(\);/, 'before the inverters are polled');
assert.match(server, /if \(has\('dongle_config'\)\) \{ updateInverterMetrics\(\); restartDonglePolling\(\); \}/);
checks.done();
