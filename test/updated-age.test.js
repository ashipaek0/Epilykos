'use strict';
const checks = require('./_checks');
// "Updated 12 s ago" in the dashboard header: the wording, when it turns to a
// warning, and that every way data reaches the page marks it.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const src = read('public/js/updated-age.js').replace(/^export /gm, '');
const ctx = { Date, Math, Number };
vm.runInNewContext(src + '\nthis.ageText = ageText; this.isStale = isStale;', ctx);
const s = n => n * 1000, min = n => s(n * 60), h = n => min(n * 60);

assert.equal(ctx.ageText(0), 'Updated just now');
assert.equal(ctx.ageText(s(4)), 'Updated just now');
assert.equal(ctx.ageText(s(5)), 'Updated 5 s ago');
assert.equal(ctx.ageText(s(59)), 'Updated 59 s ago');
assert.equal(ctx.ageText(s(60)), 'Updated 1 min ago');
assert.equal(ctx.ageText(min(59)), 'Updated 59 min ago');
assert.equal(ctx.ageText(h(2)), 'Updated 2 h ago');
assert.equal(ctx.ageText(h(49)), 'Updated 2 d ago');
assert.equal(ctx.ageText(-500), 'Updated just now', 'a clock that moved back is not negative');
assert.equal(ctx.isStale(s(119)), false);
assert.equal(ctx.isStale(s(120)), true, 'two minutes without data (four polling cycles) is stale');

// Every path that delivers data marks it: full state (WebSocket, fetch, saved copy) and a delta.
assert.match(read('public/js/updater.js'), /export function updateWithState\(state, \{ at \} = \{\}\) \{\s*markFresh\(at\)/, 'updateWithState marks the page');
assert.match(read('public/js/dashboard.js'), /addEventListener\('state-updated', \(event\) => \{[^}]*?markFresh\(\)/, 'a delta marks the page, even when it re-renders everything');
assert.match(read('public/js/main.js'), /updateWithState\(cached, \{ at: \(await loadCachedAt\(\)\) \?\? 0 \}\)/, 'the saved copy is marked with when it was received');
assert.match(read('public/js/ws-manager.js'), /put\(Date\.now\(\), 'latestAt'\)/, 'the time is saved with the copy');
assert.match(read('public/js/updated-age.js'), /if \(when === 0\) return;/, 'a saved copy of unknown age says nothing');

assert.match(read('public/js/updated-age.js'), /node\.hidden = Boolean\(document\.querySelector\('\.so-updated'\)\)/, 'hidden where the System overview card shows its own Last updated');

checks.done();
