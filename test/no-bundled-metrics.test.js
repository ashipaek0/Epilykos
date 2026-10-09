'use strict';
const checks = require('./_checks');
// No bundled metric names or images: new installs start empty, old installs
// lose only the bundled names nothing uses, starter dashboards follow roles.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-no-bundled-'));
process.chdir(tmp);
const database = require('../modules/database');

check('a new install has no metric names', () => {
  database.initializeDatabase();
  const list = JSON.parse(database.getConfig('user_metrics') || '[]');
  assert.deepStrictEqual(list, []);
});

check('an older install keeps bundled names that are used and loses the rest', () => {
  const { getConfig, setConfig, getDb } = database;
  setConfig('seeded_metrics_cleanup_v1', '');
  setConfig('user_metrics', JSON.stringify([
    { name: 'PV Power', unit: 'W' },            // bundled, mapped to a role -> stays
    { name: 'Battery SOC', unit: '%' },         // bundled, has readings -> stays
    { name: 'Load Current', unit: 'A' },        // bundled, unused -> goes
    { name: 'Grid Frequency', unit: 'hz' },     // bundled, unused -> goes
    { name: 'garage_pv_power', unit: 'W' }      // the person's own -> stays
  ]));
  setConfig('role_metrics', JSON.stringify({ solar: 'PV Power' }));
  getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run('Battery SOC', 55, Math.floor(Date.now() / 1000));
  database.initializeDatabase();
  const names = JSON.parse(getConfig('user_metrics')).map(m => m.name);
  assert.deepStrictEqual(names.sort(), ['Battery SOC', 'PV Power', 'garage_pv_power']);
  assert.strictEqual(getConfig('seeded_metrics_cleanup_v1'), 'done');
});

check('the starter dashboard has no bundled metric names, images or place names', () => {
  const json = database.DEFAULT_DASHBOARD_LAYOUTS_JSON;
  for (const bad of ['PV Power', 'Battery SOC', 'Load Power', 'Grid Power', 'postimg', 'srne', 'Lagos', 'inverter_image']) assert.ok(!json.includes(bad), bad);
  const src = fs.readFileSync(path.join(root, 'modules/dashboard-config.js'), 'utf8');
  for (const bad of ['PV Power', 'postimg', 'inverter_image:']) assert.ok(!src.includes(bad), bad);
});

check('role placeholders fill from the chosen roles, or stay empty', () => {
  const { resolveRoleTokens } = require('../modules/dashboard-config');
  const out = resolveRoleTokens({ a: '{{role:solar}}', b: ['{{role:battery_soc}}', 'plain'], c: { d: '{{role:none}}' } }, { solar: 'pv_total', battery_soc: ' soc ' });
  assert.deepStrictEqual(out, { a: 'pv_total', b: ['soc', 'plain'], c: { d: '' } });
});

console.log(`no-bundled-metrics: ${passed} checks passed`);
checks.done();
