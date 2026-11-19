'use strict';
const checks = require('./_checks');
// Setup health: each check's levels, the "fresh install" list, dismissing warnings, and the wiring.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { evaluate, applyDismissed, attentionCount } = require('../modules/setupHealth');

const NOW = 1_800_000_000;
const good = () => ({
  now: NOW, sourcesConfigured: 2, newestReading: NOW - 30,
  roles: { solar: 'pv_power', consumption: 'load_power', battery_soc: 'battery_soc', grid_import: 'grid_import' },
  timeZone: 'Africa/Lagos', location: { lat: 6.5, lon: 3.3 },
  snapshots: { count: 3, newest: NOW - 3600, overdue: false, error: null }, cloudBackup: true,
  twoStep: true, notifications: { enabled: true, channels: 1, devices: 1 }, diskFreeMb: 50000,
});
const by = (list, id) => list.find(c => c.id === id);
const lvl = (facts, id) => by(evaluate(facts), id).level;
const over = (o) => Object.assign(good(), o);

// A healthy system is all ok, with a stable set and order of checks.
const all = evaluate(good());
assert.deepEqual(all.map(c => c.level).filter(l => l !== 'ok'), [], 'nothing to do on a healthy system');
assert.deepEqual(all.map(c => c.id), ['source', 'roles', 'timezone', 'location', 'backup', 'offsite', 'twostep', 'notifications', 'disk']);
for (const c of all) assert.ok(c.title && typeof c.detail === 'string' && typeof c.fix === 'string', c.id + ' has text');

// Data source.
assert.equal(lvl(over({ sourcesConfigured: 0 }), 'source'), 'fail');
assert.equal(lvl(over({ newestReading: null }), 'source'), 'warn', 'set up but nothing read yet');
assert.equal(lvl(over({ newestReading: NOW - 20 * 60 }), 'source'), 'fail', 'readings stopped');
assert.match(by(evaluate(over({ newestReading: NOW - 3 * 3600 })), 'source').detail, /3 hours ago/);
assert.equal(lvl(over({ newestReading: NOW - 10 * 60 }), 'source'), 'ok', 'ten minutes is still fine');

// Roles.
assert.equal(lvl(over({ roles: {} }), 'roles'), 'warn');
assert.equal(lvl(over({ roles: { solar: 'a' } }), 'roles'), 'warn', 'load missing');
assert.equal(lvl(over({ roles: { solar: 'a', consumption: 'b' } }), 'roles'), 'ok', 'solar and load are enough');
assert.match(by(evaluate(over({ roles: { solar: 'a', consumption: 'b' } })), 'roles').detail, /battery charge, grid import/);

// Time zone and location.
for (const tz of ['UTC', 'Etc/UTC', 'GMT', '']) assert.equal(lvl(over({ timeZone: tz }), 'timezone'), 'warn', tz || 'empty');
assert.equal(lvl(over({ location: null }), 'location'), 'warn');
assert.equal(lvl(over({ location: { lat: NaN, lon: NaN } }), 'location'), 'warn');
assert.equal(lvl(over({ location: { lat: 0, lon: 0 } }), 'location'), 'warn', '0,0 is the unset default');

// Backups.
assert.equal(lvl(over({ snapshots: { count: 0, newest: null } }), 'backup'), 'warn');
assert.equal(lvl(over({ snapshots: { count: 1, newest: NOW - 10, error: 'disk full' } }), 'backup'), 'fail');
assert.equal(lvl(over({ snapshots: { count: 1, newest: NOW - 4 * 86400, overdue: false } }), 'backup'), 'warn', 'four days old');
assert.equal(lvl(over({ snapshots: { count: 1, newest: NOW - 60, overdue: true } }), 'backup'), 'warn');
assert.equal(lvl(over({ cloudBackup: false }), 'offsite'), 'warn');

// Sign-in, notifications.
assert.equal(lvl(over({ twoStep: false }), 'twostep'), 'warn');
assert.equal(lvl(over({ notifications: { enabled: true, channels: 0, devices: 0 } }), 'notifications'), 'warn', 'on with nowhere to go');
assert.equal(lvl(over({ notifications: { enabled: false, channels: 0, devices: 0 } }), 'notifications'), 'ok', 'off is a choice');
assert.equal(lvl(over({ notifications: { enabled: true, channels: 0, devices: 2 } }), 'notifications'), 'ok');

// Disk.
assert.equal(lvl(over({ diskFreeMb: 100 }), 'disk'), 'fail');
assert.equal(lvl(over({ diskFreeMb: 500 }), 'disk'), 'warn');
assert.equal(lvl(over({ diskFreeMb: 2048 }), 'disk'), 'ok');
assert.equal(by(evaluate(over({ diskFreeMb: null })), 'disk'), undefined, 'no disk figure, no disk check');
assert.match(by(evaluate(over({ diskFreeMb: 2048 })), 'disk').detail, /2\.0 GB/);

// A fresh install: several things to do, and the order is stable.
const fresh = evaluate({ now: NOW, sourcesConfigured: 0, newestReading: null, roles: {}, timeZone: 'UTC', location: null,
  snapshots: { count: 0 }, cloudBackup: false, twoStep: false, notifications: { enabled: true, channels: 0, devices: 0 }, diskFreeMb: 9000 });
assert.deepEqual(fresh.filter(c => c.level !== 'ok').map(c => c.id), ['source', 'roles', 'timezone', 'location', 'backup', 'offsite', 'twostep', 'notifications']);
assert.equal(by(fresh, 'source').fix, '#sources');

// Dismissing hides warnings, never failures, and stops them counting.
let c = applyDismissed(fresh, ['roles', 'twostep', 'source']);
assert.equal(by(c, 'roles').dismissed, true);
assert.equal(by(c, 'source').dismissed, false, 'a failure cannot be dismissed');
assert.equal(attentionCount(applyDismissed(fresh, [])), 8);
assert.equal(attentionCount(c), 6, 'two warnings hidden');
assert.equal(attentionCount(applyDismissed(evaluate(good()), [])), 0);
assert.deepEqual(applyDismissed(fresh, null).filter(x => x.dismissed), [], 'bad stored value is ignored');

// Wiring.
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
assert.match(read('server.js'), /app\.use\('\/api\/setup-health', isAuthenticated, require\('\.\/routes\/setupHealth'\)\)/, 'signed in only');
assert.match(read('public/settings.html'), /id="section-health"/);
assert.match(read('public/settings.html'), /data-section="health"/);
assert.match(read('public/settings.html'), /js\/health-settings\.js/);
assert.match(read('public/js/settings-shell.js'), /health: 'Health'/, 'the section has a title');
assert.doesNotMatch(read('public/js/health-settings.js'), /innerHTML\s*=/, 'rows are drawn with textContent');
assert.match(read('routes/setupHealth.js'), /\^\[a-z\]\{2,24\}\$/, 'dismiss ids are checked');
console.log('ok - setup health');
checks.done();
