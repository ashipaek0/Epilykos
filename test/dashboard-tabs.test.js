'use strict';
const checks = require('./_checks');
// Dashboard tabs: everyone sees the dashboards, only a signed-in session sees Controls, the bar can sit top / left /
// right (phones: top), it can be folded away, and a visitor switching tabs must not try to save anything.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const src = read('public/js/dashboard-tabs.js');
  const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

  const two = [{ id: 'main', name: 'Main' }, { id: 'power', name: 'Power' }];
  const visitor = m.tabsFor(two, false);
  assert.deepEqual(visitor.tabs.map(t => t.label), ['Main', 'Power']);
  assert.equal(visitor.show, true);
  assert.ok(!visitor.tabs.some(t => t.href === '/controls'), 'a visitor is never shown Controls');

  assert.equal(m.tabsFor([two[0]], false).show, false, 'one dashboard: nothing to choose, no bar');
  const admin = m.tabsFor([two[0]], true);
  assert.equal(admin.show, true, 'signed in: the bar always shows (Controls lives there)');
  assert.deepEqual(admin.tabs.map(t => t.label), ['Main', 'Controls']);
  assert.equal(admin.tabs[1].href, '/controls');

  assert.equal(m.tabsPosition('left'), 'left');
  assert.equal(m.tabsPosition('right'), 'right');
  assert.equal(m.tabsPosition('diagonal'), 'top');
  assert.equal(m.tabsPosition(undefined), 'top');
  assert.equal(m.effectivePosition('left', 390), 'top', 'phones keep the bar along the top');
  assert.equal(m.effectivePosition('left', 1280), 'left');

  const mem = {}; const store = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; } };
  assert.equal(m.readCollapsed(store), false);
  m.writeCollapsed(true, store); assert.equal(m.readCollapsed(store), true);
  m.writeCollapsed(false, store); assert.equal(m.readCollapsed(store), false);
  assert.equal(m.readCollapsed({ getItem() { throw new Error('blocked'); } }), false, 'blocked storage: tabs stay shown');

  // Wiring: the setting is saved, served to visitors and shown in Settings; Controls left the header.
  for (const f of ['server.js', 'routes/metrics.js', 'modules/database.js']) assert.match(read(f), /'tabs_position'/, f + ' knows tabs_position');
  assert.match(read('public/settings.html'), /name="tabs_position"/);
  const js = read('public/js/dashboard.js');
  assert.doesNotMatch(js, /controls-link/, 'no Controls link in the header any more');
  assert.match(js, /if \(signedIn\) await saveDashboardConfig/, 'only a signed-in session saves the shown dashboard');
  assert.match(js, /tabs: *tabsFor|tabsFor\(dashboardConfig\.dashboards, signedIn\)/);
  const css = read('public/style.css');
  assert.match(css, /#tab-bar\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /data-tabs="left"/); assert.match(css, /data-tabs="right"/);

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
