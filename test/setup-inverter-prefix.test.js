'use strict';
const checks = require('./_checks');
// Setup wizard: changing the first inverter's prefix renames its mapped
// readings (and the roles chosen for them); "more inverters like this one"
// get their names under their own prefix even when the first's prefix was
// typed without its underscore. Runs the real functions from setup.js.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../public/js/setup.js'), 'utf8');
const fn = name => { const m = src.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`)); assert.ok(m, name); return m[0]; };
const ctx = { state: null };
vm.createContext(ctx);
vm.runInContext(['stripPrefix', 'withPrefix', 'reprefixDongle'].map(fn).join('\n') + '\nthis.api = { stripPrefix, withPrefix, reprefixDongle };', ctx);
const { stripPrefix, withPrefix, reprefixDongle } = ctx.api;

assert.equal(stripPrefix('inv1_pv_power', 'inv1_'), 'pv_power');
assert.equal(stripPrefix('inv1pv_power', 'inv1_'), 'pv_power', 'prefix typed without its underscore');
assert.equal(stripPrefix('house_load', 'inv1_'), null);
assert.equal(stripPrefix('pv_power', ''), 'pv_power');
assert.deepEqual({ ...withPrefix({ inv1battery_soc: 'a', inv1_pv_power: 'b' }, 'inv1_', 'inv2_') }, { inv2_battery_soc: 'a', inv2_pv_power: 'b' });
assert.deepEqual({ ...withPrefix({ battery_soc: 'a' }, '', 'inv2_') }, { inv2_battery_soc: 'a' }, 'a first inverter without a prefix');
console.log('ok - extra inverters: names under their own prefix, from exact or loose first prefixes');

ctx.state = { sources: { dongle: { prefix: '', mappings: { battery_soc: 'h1', pv_power: 'h2' } } }, roleMetrics: { battery_soc: 'battery_soc', solar: 'pv_power' } };
const typed = ['i', 'in', 'inv', 'inv1', 'inv1_'];
let prev = '';
for (const p of typed) { ctx.state.sources.dongle.prefix = p; reprefixDongle(prev, p); prev = p; }
assert.deepEqual({ ...ctx.state.sources.dongle.mappings }, { inv1_battery_soc: 'h1', inv1_pv_power: 'h2' });
assert.deepEqual({ ...ctx.state.roleMetrics }, { battery_soc: 'inv1_battery_soc', solar: 'inv1_pv_power' }, 'role names stay; their metrics follow');
ctx.state.sources.dongle.mappings.house_load = 'h3';
reprefixDongle('inv1_', 'site_');
assert.deepEqual(Object.keys(ctx.state.sources.dongle.mappings).sort(), ['house_load', 'site_battery_soc', 'site_pv_power'], 'a hand-picked name stays');
reprefixDongle('site_', '');
assert.deepEqual(Object.keys(ctx.state.sources.dongle.mappings).sort(), ['battery_soc', 'house_load', 'pv_power'], 'clearing the prefix gives the plain names back');
console.log('ok - typing a prefix moves the first inverter\'s names (and roles) under it, letter by letter');

assert.match(src, /var oldPrefix = field === 'sources\.dongle\.prefix' \? String\(state\.sources\.dongle\.prefix \|\| ''\) : null;/);
assert.match(src, /if \(oldPrefix !== null\) reprefixDongle\(oldPrefix, String\(state\.sources\.dongle\.prefix \|\| ''\)\);/);
checks.done();
