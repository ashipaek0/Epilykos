'use strict';
// Two inverters on the same profile must not write the same metric names.
const assert = require('assert');
const { dongleNameClash } = require('../modules/sourceChecks');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const ph = (name, prefix, extra = {}) => ({ name, profile: 'phocos-anygrid-ble', prefix, enabled: true, mappings: {}, ...extra });

check('same profile, no prefix: refused with a plain explanation', () => {
  const msg = dongleNameClash([ph('Phocos 1', ''), ph('Phocos 2', '')]);
  assert.match(msg, /"Phocos 1" and "Phocos 2" use the same profile with no metric prefix/);
  assert.match(msg, /inv1_ and inv2_/);
});
check('same profile and prefix (any case): refused', () => { assert.ok(dongleNameClash([ph('A', 'inv_'), ph('B', 'INV_')])); });
check('different prefixes, different profiles, a disabled twin, or own mappings: fine', () => {
  assert.strictEqual(dongleNameClash([ph('A', 'inv1_'), ph('B', 'inv2_')]), null);
  assert.strictEqual(dongleNameClash([ph('A', ''), { ...ph('B', ''), profile: 'srne' }]), null);
  assert.strictEqual(dongleNameClash([ph('A', ''), ph('B', '', { enabled: false })]), null);
  assert.strictEqual(dongleNameClash([ph('A', ''), ph('B', '', { mappings: { b_pv: '0x10' } })]), null);
  assert.strictEqual(dongleNameClash(null), null);
});
check('the settings save refuses a clash, and Settings suggests a prefix', () => {
  const fs = require('fs'), path = require('path');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /dongleNameClash\(devices\);\s*if \(clash\) return res\.status\(400\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public/settings.js'), 'utf8'), /prefixEl\.value = `inv\$\{n\}_`/);
});
const { bankOutputClash } = require('../modules/sourceChecks');
check('battery bank metrics must have unique names across banks', () => {
  const bank = (name, outputs, extra = {}) => ({ name, enabled: true, functions: outputs.map(output => ({ output, fn: 'sum' })), ...extra });
  assert.strictEqual(bankOutputClash([bank('House', ['house_soc', 'house_voltage']), bank('Shed', ['shed_soc'])]), null);
  assert.match(bankOutputClash([bank('House', ['soc']), bank('Shed', ['SOC'])]), /"House" and "Shed" both have a metric called "SOC".*bank_SOC/);
  assert.match(bankOutputClash([bank('House', ['soc', 'soc'])]), /two metrics called "soc"/);
  assert.strictEqual(bankOutputClash([bank('House', ['soc']), bank('Old', ['soc'], { enabled: false })]), null);
});
check('battery banks: plain calculation names, one-click usual metrics, saves refuse clashes', () => {
  const fs = require('fs'), path = require('path'), read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const js = read('public/settings.js');
  assert.match(js, /weighted_soc: 'Charge, weighted by capacity'/);
  assert.match(js, /\['soc', 'weighted_soc', \['battery_level', 'soc'\]\]/);
  assert.match(js, /class="st-btn add-bank-starter"/);
  for (const cls of ['bank-fn-output', 'bank-fn-type', 'bank-fn-source', 'bank-fn-weightby', 'remove-bank-fn']) assert.ok(js.includes(cls), cls + ' kept for the save collectors');
  assert.match(read('server.js'), /bankOutputClash\(banks\);\s*if \(clash\) return res\.status\(400\)/);
});
console.log(`source-checks: ${passed} checks passed`);
