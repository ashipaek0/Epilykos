'use strict';
// System overview card: registered, live-updated, safe image, battery history sent.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const src = read('public/js/components/systemOverview.js');
check('registered, in the library and updated with each dashboard state', () => {
  assert.match(read('public/js/components/index.js'), /'system-overview': buildSystemOverview/);
  assert.match(read('public/js/editor-catalog.js'), /'system-overview':\s*\{ group: 'flow', name: 'System overview'/);
  assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('system-overview'\)\) updateSystemOverview\(state\)/);
});
check('the inverter image only accepts web addresses or site paths', () => {
  assert.match(src, /\/\^\(https\?:\\\/\\\/\|\\\/\)\/i\.test\(config\.inverter_image\)/);
  assert.match(read('public/js/editor.js'), /Inverter image must be a web address/);
});
check('lines run towards the hub for import, discharge and solar, away for charging and home', () => {
  assert.match(src, /set\('grid', gridW, gridW > 0\)/); assert.match(src, /set\('battery', battW, battW < 0\)/);
  assert.match(src, /set\('solar', watts\(c\.solar_kw\), true\)/); assert.match(src, /set\('home', watts\(c\.consumption_kw\), false\)/);
});
check('the dashboard sends battery charge history for the battery sparkline', () => {
  assert.match(read('routes/metrics.js'), /battery_soc: r\.battery_soc \?\? null/);
});
check('up to three extra values, saved from the editor', () => {
  assert.match(src, /\.slice\(0, 3\)/); assert.match(read('public/js/editor.js'), /config\.extras = soOut/);
});
console.log(`system-overview-card: ${passed} checks passed`);
