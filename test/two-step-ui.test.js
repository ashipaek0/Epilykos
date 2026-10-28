'use strict';
/**
 * test/two-step-ui.test.js — the pages and wiring for two-step sign-in:
 * the login page's code step, the Settings → Security section, the routes
 * mounted behind the session, and the Docker reset at start.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const login = read('public/login.html');
assert.match(login, /id="code-form"[^>]*hidden/);
assert.match(login, /autocomplete="one-time-code"/);
assert.match(login, /fetch\('\/api\/login\/code'/);
assert.match(login, /data\.needsCode/);
assert.match(login, /RESET_TWO_STEP=true/);
// The script is valid JavaScript.
// The page has one inline script, a bare <script>; find it by plain text, not by a pattern over HTML.
assert.equal(login.split('<script>').length, 2, 'exactly one bare inline <script>');
const opening = login.indexOf('<script>') + '<script>'.length;
const inline = login.slice(opening, login.indexOf('</script>', opening));
assert.ok(inline.trim().length > 0 && !inline.includes('<script'));
new Function(inline);
assert.match(login, /<script src="js\/safe-next\.js\?v=1"><\/script>/);
assert.match(inline, /safeNext\(new URLSearchParams\(location\.search\)\.get\('next'\), location\.origin\)/);
assert.doesNotMatch(inline, /location\.href = \/\^/, 'no hand-written pattern decides where to go');
console.log('ok - the login page has the code step, a recovery switch and the Docker note');

const settings = read('public/settings.html');
assert.match(settings, /data-section="security"/);
assert.match(settings, /id="section-security"/);
assert.match(settings, /id="ts-root"/);
assert.match(settings, /<script src="js\/two-step-settings\.js\?v=1"><\/script>/);
assert.match(read('public/js/settings-shell.js'), /security: 'Security'/);
assert.match(read('public/js/settings-shell.js'), /\block: '/);
const script = read('public/js/two-step-settings.js');
new Function(script);
assert.match(script, /type="checkbox" id="ts-toggle"|id="ts-toggle"/);
assert.doesNotMatch(script, /type="radio"|type=radio/, 'a toggle switch, not radio buttons');
for (const route of ['/begin', '/enable', '/disable', '/recovery', '/status']) assert.ok(script.includes(`'${route}'`), route);
console.log('ok - Settings has a Security section with a toggle switch and the five calls');

const server = read('server.js');
assert.match(server, /app\.use\('\/api\/two-step', isAuthenticated, require\('\.\/routes\/twoStep'\)\)/);
assert.match(server, /require\('\.\/modules\/twoStep'\)\.applyEnvReset\(\)/);
console.log('ok - the settings routes need a signed-in session; RESET_TWO_STEP is applied at start');

checks.done();
