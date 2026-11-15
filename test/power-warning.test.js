'use strict';
const checks = require('./_checks');
// The Settings low-power warning: what it says for each report from the host,
// and that the page loads it.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { describe } = require('../public/js/power-warning.js');

assert.equal(describe(null), null, 'no report, no warning');
assert.equal(describe({ supported: false, undervoltage_now: true }), null, 'a box that cannot tell says nothing');
assert.equal(describe({ supported: true, undervoltage_now: false, undervoltage_since_boot: false }), null, 'a fine supply says nothing');

const now = describe({ supported: true, undervoltage_now: true, undervoltage_since_boot: true, last_seen: 1767225600 });
assert.equal(now.now, true);
assert.match(now.text, /too low right now/);
assert.match(now.text, /SD card/);

const before = describe({ supported: true, undervoltage_now: false, undervoltage_since_boot: true, last_seen: 1767225600 });
assert.equal(before.now, false);
assert.match(before.text, /since the last start \(last at /);
assert.notEqual(before.key, now.key, 'a dismissed old dip does not hide a new one');
const another = describe({ supported: true, undervoltage_now: false, undervoltage_since_boot: true, last_seen: 1767229999 });
assert.notEqual(another.key, before.key, 'a later dip shows again after a dismiss');
assert.doesNotMatch(describe({ supported: true, undervoltage_since_boot: true, last_seen: null }).text, /last at/, 'no time to give, none given');

const html = fs.readFileSync(path.join(__dirname, '..', 'public/settings.html'), 'utf8');
assert.match(html, /src="js\/power-warning\.js/, 'the settings page loads the warning');
assert.ok(html.indexOf('js/power-warning.js') > html.indexOf('js/settings-shell.js'), 'after the shell');

checks.done();
