'use strict';
const checks = require('./_checks');
// Costs and earnings card: registered, signs, forecast costs from projected flows.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const src = read('public/js/components/energyCosts.js');
check('registered and in the library', () => {
  assert.match(read('public/js/components/index.js'), /'energy-costs': buildEnergyCosts/);
  assert.match(read('public/js/editor-catalog.js'), /'energy-costs':\s*\{ group: 'charts', name: 'Costs and earnings'/);
});
check('earnings above zero, costs below', () => {
  assert.match(src, /key: 'grid_earnings'[^}]*side: 1/); assert.match(src, /key: 'grid_cost'[^}]*side: -1/); assert.match(src, /key: 'battery_cost'[^}]*side: -1/);
});
check('forecast costs: imports at the buy price, exports at the sell price, battery kWh at the wear cost', () => {
  const start = src.indexOf('function forecastCosts('), end = src.indexOf('\n}\n', start) + 2;
  const forecastCosts = new Function(`${src.slice(start, end)}; return forecastCosts;`)();
  const c = forecastCosts({ solar_to_home: 1, solar_to_battery: 2, battery_to_home: 1, grid_to_home: 0.5 }, { buy: 0.3, sell: 0.1, batteryWear: 0.05 });
  assert.ok(Math.abs(c.grid_cost - 0.15) < 1e-9); assert.equal(c.grid_earnings, 0); assert.ok(Math.abs(c.battery_cost - 0.15) < 1e-9);
});
check('amounts always show two decimals and a minus sign when negative', () => {
  assert.match(src, /minimumFractionDigits: 2, maximumFractionDigits: 2/); assert.match(src, /v < 0 \? '−' : ''/);
});
check('the server computes each hour\'s costs the same way', () => {
  const m = read('modules/energyHourly.js');
  assert.match(m, /grid_cost: round\(energy\.grid_import \* buy/); assert.match(m, /grid_earnings: round\(energy\.grid_export \* sell/);
  assert.match(m, /battery_cost: round\(\(energy\.battery_charge \+ energy\.battery_discharge\) \* wear/);
});
console.log(`energy-costs-card: ${passed} checks passed`);
checks.done();
