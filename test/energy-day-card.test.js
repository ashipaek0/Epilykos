'use strict';
// Energy day card is registered, in the library, and its settings save.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

check('registered as a block and listed in the library', () => {
  assert.match(read('public/js/components/index.js'), /'energy-day': buildEnergyDay/);
  assert.match(read('public/js/editor-catalog.js'), /'energy-day':\s*\{ group: 'charts', name: 'Energy day'/);
});
check('fetches its day with forecasts from the hourly energy endpoint', () => {
  const src = read('public/js/components/energyDay.js');
  assert.match(src, /\/api\/energy\/hourly\?date=\$\{date\}/);
  assert.match(src, /&forecast=1/);
});
check('battery % has its own panel, not a second axis on the energy chart', () => {
  const src = read('public/js/components/energyDay.js');
  assert.doesNotMatch(src, /yAxisID|position: 'right'/);
  assert.match(src, /offset: true/, 'both panels centre hours the same way so they line up');
});
check('settings form has the forecast and battery toggles and reads them back', () => {
  const ed = read('public/js/editor.js');
  assert.match(ed, /id="modal-ed-forecast"/); assert.match(ed, /id="modal-ed-battery"/);
  assert.match(ed, /config\.showForecast = edF\.checked/); assert.match(ed, /config\.showBattery = edB\.checked/);
});
console.log(`energy-day-card: ${passed} checks passed`);
