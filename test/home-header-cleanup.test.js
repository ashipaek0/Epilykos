'use strict';
/**
 * test/home-header-cleanup.test.js — the home page no longer has an Install
 * button, a Sign in link or the Auto/Local/Remote network control, and the
 * grid status card has no "Grid" heading.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const html = read('public/index.html');
assert.ok(!html.includes('signin-btn') && !/>\s*Sign in\s*</.test(html), 'no Sign in link');
assert.ok(html.includes('id="signout-btn"') && html.includes('id="settings-btn"'), 'Sign out and Settings stay for a signed-in session');
assert.ok(!read('public/style.css').includes('#signin-btn'));
assert.ok(!read('public/js/dashboard.js').includes('signin-btn'));
console.log('ok - no Sign in link on the home page; Sign out and Settings remain');

const main = read('public/js/main.js');
assert.ok(!/beforeinstallprompt|pwa-install-btn|appinstalled/.test(main), 'no Install button');
console.log('ok - no Install button');

const net = read('public/js/network-detect.js');
for (const gone of ['epilykos-network-indicator', 'epilykos-network-mode-select', 'epilykos-network-handle', "createElement('select')"]) {
  assert.ok(!net.includes(gone), `${gone} is gone`);
}
assert.match(net, /localStorage\.removeItem\(NET_MODE_KEY\)/, 'an old saved pin is dropped');
assert.match(net, /window\.EpilykosNetwork = \{/, 'the failover API stays');
assert.match(net, /async function handleTick/, 'failover stays');
new Function(net.replace(/^\s*import .*$/gm, ''));
console.log('ok - no Local/Remote control; base failover and the saved-pin cleanup remain');

const grid = read('public/js/components/gridCard.js');
assert.ok(!/<h3[^>]*>\s*Grid\s*<\/h3>/.test(grid), 'no Grid heading');
assert.ok(grid.includes('class="grid-date"'), 'the date stays');
console.log('ok - the grid status card has no "Grid" heading');

checks.done();
