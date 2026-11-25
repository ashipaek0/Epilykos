'use strict';
const checks = require('./_checks');
// Visitors see only the dashboards chosen as the default on computers / phones, plus any expressly enabled.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { visibleIds, forVisitor, parseIds } = require('../modules/dashboardVisibility');

const cfg = { activeDashboard: 'main', dashboards: [
  { id: 'main', name: 'Main', layout: [{ type: 'a' }] }, { id: 'power', name: 'Power', layout: [] },
  { id: 'energy', name: 'Energy', layout: [] }, { id: 'admin', name: 'Admin', layout: [{ secret: 1 }] }] };

// Nothing chosen: only the shown dashboard.
assert.deepEqual(visibleIds(cfg, {}), ['main']);
// Computer and phone defaults are visible, in dashboard order, and nothing else.
assert.deepEqual(visibleIds(cfg, { desktop: 'energy', mobile: 'power' }), ['power', 'energy']);
assert.deepEqual(visibleIds(cfg, { desktop: 'power', mobile: 'power' }), ['power']);
// Others only when expressly enabled.
assert.deepEqual(visibleIds(cfg, { desktop: 'main', mobile: 'main', extra: '["energy"]' }), ['main', 'energy']);
assert.deepEqual(visibleIds(cfg, { desktop: 'main', extra: ['admin'] }), ['main', 'admin']);
// Junk and stale ids are ignored; a deleted default falls back to the shown dashboard.
assert.deepEqual(visibleIds(cfg, { desktop: 'gone', mobile: '', extra: 'not json' }), ['main']);
assert.deepEqual(visibleIds(cfg, { extra: '["nope",7,null]' }), ['main']);
assert.deepEqual(parseIds('{"a":1}'), []);
assert.deepEqual(visibleIds({ dashboards: [] }, {}), []);
assert.deepEqual(visibleIds({ activeDashboard: 'zzz', dashboards: [{ id: 'x', name: 'X' }] }, {}), ['x'], 'unknown active: first dashboard');

// The visitor's copy never contains a hidden dashboard, layout included.
const v = forVisitor(cfg, { desktop: 'power', mobile: 'power' });
assert.deepEqual(v.dashboards.map(d => d.id), ['power']);
assert.equal(v.activeDashboard, 'power', 'the active one is moved to a visible one');
assert.ok(!JSON.stringify(v).includes('secret'), 'hidden layout is not sent');
assert.equal(cfg.dashboards.length, 4, 'the stored config is untouched');

// Wiring.
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.match(read('routes/metrics.js'), /forVisitor\(config/);
assert.match(read('routes/metrics.js'), /req\.session && req\.session\.authenticated\) return res\.json\(config\)/, 'a signed-in session gets all dashboards');
for (const f of ['routes/settings.js', 'modules/database.js']) assert.match(read(f), /'public_dashboards'/);
assert.match(read('public/settings.html'), /name="public_dashboards"/);
checks.done();
