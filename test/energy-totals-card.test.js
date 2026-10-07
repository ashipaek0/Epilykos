'use strict';
// Day totals card: registered, in the library, tiles pick and save.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
check('registered and in the library', () => {
  assert.match(read('public/js/components/index.js'), /'energy-totals': buildEnergyTotals/);
  assert.match(read('public/js/editor-catalog.js'), /'energy-totals':\s*\{ group: 'values', name: 'Day totals'/);
});
check('reads today with the day forecast; consumption and solar compare against it', () => {
  const src = read('public/js/components/energyTotals.js');
  assert.match(src, /\/api\/energy\/hourly\?forecast=1/);
  assert.match(src, /consumption: \{[^}]*forecast: 'consumption'/); assert.match(src, /solar: \{[^}]*forecast: 'solar'/);
  assert.match(src, /% of forecast/);
});
check('editor saves the picked values and refuses none', () => {
  const ed = read('public/js/editor.js');
  assert.match(ed, /class="et-pick" data-key="/); assert.match(ed, /config\.show = etKeys/); assert.match(ed, /Pick at least one value to show\./);
});
console.log(`energy-totals-card: ${passed} checks passed`);
