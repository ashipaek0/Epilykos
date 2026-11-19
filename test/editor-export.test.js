'use strict';
const checks = require('./_checks');
// Layout editor: export one dashboard, a chosen few, or all.
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/editor.js'), 'utf8');
const fn = name => { const m = src.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); assert.ok(m, name); return m[0]; };

let saved, fileName;
const ctx = {
  JSON, Object, Array, String,
  syncLayoutFromGrid() {}, onControlsTab: () => false, toast() {},
  currentTabId: 'b',
  dashboardConfig: { theme: 'x', activeDashboard: 'a', dashboards: [{ id: 'a', name: 'Home' }, { id: 'b', name: 'Solar & Battery!' }] },
  URL: { createObjectURL: blob => { saved = blob; return 'blob:x'; }, revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.text = parts.join(''); } },
  setTimeout() {},
  document: { createElement: () => { const a = { click() { fileName = a.download; } }; return a; } },
};
vm.runInNewContext(`${fn('exportFileName')}; ${fn('exportLayout')}; ${fn('exportThisDashboard')}; this.exportLayout = exportLayout; this.exportThisDashboard = exportThisDashboard;`, ctx);

ctx.exportThisDashboard();
let out = JSON.parse(saved.text);
assert.deepEqual(out.dashboards.map(d => d.id), ['b'], 'only the open dashboard is exported');
assert.equal(out.activeDashboard, 'b', 'the file opens on its own dashboard');
assert.equal(out.theme, 'x', 'other settings travel with it');
assert.equal(fileName, 'dashboard-solar-battery.json', 'file named after the dashboard');
assert.equal(ctx.dashboardConfig.dashboards.length, 2, 'the live layout is untouched');

ctx.exportLayout();
out = JSON.parse(saved.text);
assert.equal(out.dashboards.length, 2);
assert.equal(fileName, 'dashboard-config.json');

assert.match(src, /Export this dashboard/);
assert.match(src, /Export selected…/);
assert.match(fn('openIoMenu'), /exportMenuItems\(\)/, 'wide-screen menu');
assert.match(src, /exportMenuItems\(\)\.forEach/, 'narrow-screen dashboard menu');
console.log('ok - editor export one dashboard');
checks.done();
