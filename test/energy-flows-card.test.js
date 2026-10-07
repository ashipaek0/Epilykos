'use strict';
// Energy flows card: registered, signed axis, every flow drawn, forecast from the projection.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const src = read('public/js/components/energyFlows.js');
check('registered and in the library', () => {
  assert.match(read('public/js/components/index.js'), /'energy-flows': buildEnergyFlows/);
  assert.match(read('public/js/editor-catalog.js'), /'energy-flows':\s*\{ group: 'charts', name: 'Energy flows'/);
});
check('draws all seven flows the server reports, solar above zero and the rest below', () => {
  const { FLOWS } = require('../modules/energyHourly');
  for (const key of FLOWS) assert.match(src, new RegExp(`key: '${key}'.*side: ${key.startsWith('solar') ? '1' : '-1'}`), key);
});
check('axis numbers carry a minus sign below zero', () => {
  assert.match(src, /const signed = v =>[^\n]*'−'/);
  assert.match(src, /callback: v => signed\(v\)/);
});
check('the rest of today comes from the battery projection, hatched', () => {
  assert.match(src, /data\.forecast\?\.battery/); assert.match(src, /p\.forecast \? pattern : color/);
});
check('the projection reports the flows the card draws', () => {
  assert.match(read('modules/energyForecast.js'), /flows = \{ solar_to_home: [^}]*battery_to_home: [^}]*grid_to_home:/);
});
console.log(`energy-flows-card: ${passed} checks passed`);
