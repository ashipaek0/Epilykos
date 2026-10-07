'use strict';
// Tabbed energy card: registered, only self-updating cards, built on first open.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const src = read('public/js/components/energyTabs.js');
check('registered and in the library', () => {
  assert.match(read('public/js/components/index.js'), /'energy-tabs': buildEnergyTabs/);
  assert.match(read('public/js/editor-catalog.js'), /'energy-tabs':\s*\{ group: 'charts'/);
});
check('tabs only hold cards that fetch their own data', () => {
  const keys = [...src.matchAll(/^  '([a-z-]+)': \{ name:/gm)].map(m => m[1]);
  assert.deepEqual(keys, ['energy-day', 'energy-flows', 'energy-costs', 'energy-totals']);
  for (const f of ['energyDay.js', 'energyFlows.js', 'energyCosts.js', 'energyTotals.js']) assert.match(read('public/js/components/' + f), /fetch\('\/api\/energy\/hourly|fetch\(`\/api\/energy\/hourly/, f);
});
check('a tab\'s card is built the first time it opens, without its own title', () => {
  assert.match(src, /if \(!panel\.firstChild\)/); assert.match(src, /hideTitle: true/);
  for (const f of ['energyDay.js', 'energyFlows.js', 'energyCosts.js']) assert.match(read('public/js/components/' + f), /config\.hideTitle \?/, f);
});
check('tabs follow the ARIA tab pattern with arrow keys', () => {
  assert.match(src, /role="tablist"/); assert.match(src, /role="tab"/); assert.match(src, /role="tabpanel"/); assert.match(src, /ArrowRight/); assert.match(src, /ArrowLeft/);
});
check('editor saves up to four tabs and refuses none', () => {
  const ed = read('public/js/editor.js'); assert.match(ed, /config\.tabs = etOut/); assert.match(ed, /Pick at least one tab\./);
});
console.log(`energy-tabs-card: ${passed} checks passed`);
