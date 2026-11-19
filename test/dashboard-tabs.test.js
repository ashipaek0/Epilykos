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

  // Tabs off: the old behaviour. Visitors get no bar, an admin keeps one (folded away at first), Controls leaves it.
  assert.equal(m.tabsFor(two, false, true).show, false, 'off: a visitor never gets a bar');
  const offAdmin = m.tabsFor(two, true, true);
  assert.equal(offAdmin.show, true, 'off: a signed-in admin keeps the ☰ bar');
  assert.deepEqual(offAdmin.tabs.map(t => t.label), ['Main', 'Power'], 'off: Controls is in the header, not in the bar');
  assert.equal(m.tabsPosition('off'), 'off');
  assert.equal(m.effectivePosition('off', 390), 'off');
  assert.equal(m.effectivePosition('off', 1280), 'off');
  assert.deepEqual(m.tabsFor(two, true), { tabs: m.tabsFor(two, true).tabs, show: true }, 'on is unchanged');

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
  const empty = { getItem: () => null, setItem() {} };
  assert.equal(m.readCollapsed(empty, true), true, 'no choice yet: the fallback (folded away when tabs are off)');
  assert.equal(m.readCollapsed(empty), false);
  m.writeCollapsed(false, store); assert.equal(m.readCollapsed(store, true), false, 'a saved choice beats the fallback');
  assert.equal(m.readCollapsed({ getItem() { throw new Error('blocked'); } }, true), true);

  // Wiring: the setting is saved, served to visitors and shown in Settings; Controls left the header.
  for (const f of ['server.js', 'routes/metrics.js', 'modules/database.js']) assert.match(read(f), /'tabs_position'/, f + ' knows tabs_position');
  assert.match(read('public/settings.html'), /name="tabs_position"/);
  assert.match(read('public/settings.html'), /<option value="off">No tabs/, 'Settings offers No tabs');
  const dash = read('public/js/dashboard.js');
  assert.match(dash, /syncControlsLink\(off && signedIn\)/, 'with tabs off, Controls goes back to the header');
  assert.match(dash, /readCollapsed\(undefined, off\)/, 'with tabs off the bar starts folded away');
  const js = read('public/js/dashboard.js');
  // The header Controls link exists only for tabs-off (inside syncControlsLink); it is not added with the other signed-in links.
  const outside = js.replace(/function syncControlsLink[\s\S]*?\n}\n/, '');
  assert.doesNotMatch(outside, /controls-link/, 'Controls is a tab, not a header link, unless tabs are off');
  assert.match(js, /function syncControlsLink/);
  assert.match(js, /if \(signedIn\) await saveDashboardConfig/, 'only a signed-in session saves the shown dashboard');
  assert.match(js, /tabs: *tabsFor|tabsFor\(dashboardConfig\.dashboards, signedIn(, off)?\)/);
  const css = read('public/style.css');
  assert.match(css, /#tab-bar\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /data-tabs="left"/); assert.match(css, /data-tabs="right"/);

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
