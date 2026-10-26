'use strict';
const checks = require('./_checks');
// Settings > Metrics: toggle switches (not radio buttons) pick several metrics,
// "Delete selected" asks once and deletes them together. Checked in a browser
// too: two picked, filter, select all shows only what the filter shows, delete,
// the list and the "unsaved changes" bar behave. The rules live in
// test/metric-deletion.test.js.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('public/settings.html'), js = read('public/settings.js'), server = read('server.js');

assert.match(html, /<th scope="col" class="st-select-col"><span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="metrics-select-all"/, 'select-all is a toggle switch');
assert.match(html, /<div class="st-card" data-own-save>\s*<div class="st-card-head">\s*<h2>All metrics/, 'ticking a metric is not an unsaved change');
assert.match(js, /class="toggle-switch"><input type="checkbox" class="metric-select"/, 'each row has a toggle switch');
assert.match(js, /const pick = metric\.combined \? ''/, 'a combined metric has none (it is edited, not deleted here)');
assert.match(js, /tr:not\(\[hidden\]\) \.metric-select/, 'select all reaches only the rows the filter shows');
assert.match(js, /fetch\('\/api\/metrics\/delete', \{ method: 'POST'/, 'one request deletes them all');
assert.match(js, /confirmLabel: 'Delete'/, 'it asks once, naming how many');
assert.match(server, /app\.post\('\/api\/metrics\/delete', isAuthenticated/, 'signed-in only');
assert.match(server, /require\('\.\/modules\/metricDeletion'\)\.deleteMetrics\(names\)/);
assert.match(server, /const result = deleteMetrics\(\[name\]\);/, 'deleting one uses the same rules');
console.log('ok - select several metrics and delete them together');
checks.done();
