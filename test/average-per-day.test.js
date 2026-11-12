'use strict';
const checks = require('./_checks');
// The Average per day combined metric (modules/dailyAverages.js, modules/combinedMetrics.js): the mean of a daily
// figure over the days on record, for any metric, from the stored readings and the 5-minute summaries.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-avgday-')));
const { initializeDatabase, getDb } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const daily = require(path.join(REPO, 'modules/dailyAverages'));
const cm = require(path.join(REPO, 'modules/combinedMetrics'));
const { runMetricsBatch } = require(path.join(REPO, 'modules/retentionJob'));

const now = new Date();
const nowS = Math.floor(now.getTime() / 1000);
const at = (back, h, m = 0) => Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h, m).getTime() / 1000);
const ins = db.prepare('INSERT OR REPLACE INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)');
// A full day of readings every 5 minutes: value(secondsIntoDay) -> number
const fillDay = (metric, back, fn, fromHour = 0) => { for (let s = fromHour * 3600; s < 86400; s += 300) ins.run(at(back, 0) + s, metric, fn(s)); };

db.transaction(() => {
  // Power: 1000 W all day on days 1 and 2, 2000 W on day 3, 1500 W on day 4. 10 days back: only from midday (a partial first day).
  fillDay('load_w', 1, () => 1000); fillDay('load_w', 2, () => 1000); fillDay('load_w', 3, () => 2000); fillDay('load_w', 4, () => 1500);
  fillDay('load_w', 10, () => 9000, 12);
  // Energy today: a counter that rises through the day and restarts at midnight; day totals 10, 12, 20, 6 kWh.
  for (const [back, total] of [[1, 10], [2, 12], [3, 20], [4, 6]]) fillDay('solar_kwh', back, s => Math.round(total * s / 86400 * 1000) / 1000);
  // today: part of a day
  for (let s = 0; s < 3 * 3600; s += 300) ins.run(at(0, 0) + s, 'solar_kwh', 1.5);
  // A voltage: averages 50, 52, 54, 56 on days 1-4
  for (const [back, v] of [[1, 50], [2, 52], [3, 54], [4, 56]]) fillDay('batt_v', back, () => v);
  // A generator that ran on some days: total kWh 0, 5, 0, 7 (days 1-4)
  for (const [back, total] of [[1, 0], [2, 5], [3, 0], [4, 7]]) fillDay('gen_kwh', back, s => total * s / 86400);
})();
const stats = (metric, daily_, extra = {}) => daily.averagePerDay(db, { inputs: [metric], daily: daily_, ...extra }, now);
const near = (a, b, tol = 0.01, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

// The day's total: the highest value of each day, averaged. Today (3 hours of readings) is left out.
let r = stats('solar_kwh', 'total');
near(r.value, (10 + 12 + 20 + 6) / 4, 0.06, 'average of the day totals');   // each day's top reading is just under the full total
assert.equal(r.days, 4, 'four complete days');
assert.equal(r.to, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toLocaleDateString('sv'), 'ends yesterday');
// ... and with today included
r = stats('solar_kwh', 'total', { include_today: true });
assert.equal(r.days, 5, 'today counts when asked');
near(r.value, (10 + 12 + 20 + 6 + 1.5) / 5, 0.06, 'with today');
console.log('ok - the day total, today left out unless asked');

// Energy from power: 1000 W for 24 h = 24 kWh. A day at 2000 W is 48 kWh, 1500 W is 36 kWh.
r = stats('load_w', 'energy');
assert.equal(r.days, 4, 'day 10 began at midday, so it is not a complete first day');
near(r.value, (24 + 24 + 48 + 36) / 4, 0.3, 'energy from power');
r = stats('load_w', 'energy', { input_unit: 'kW' });
near(r.value, (24 + 24 + 48 + 36) / 4 * 1000, 300, 'the unit of the power reading');
console.log('ok - energy from a power reading, and its unit');

// The day's average and highest
near(stats('batt_v', 'average').value, 53, 0.01, 'average voltage');
near(stats('batt_v', 'peak').value, 53, 0.01, 'highest voltage');
near(stats('solar_kwh', 'peak', { days: 2 }).value, (10 + 12) / 2, 0.05, 'peak over the last days');
console.log('ok - the day average and the day peak');

// The last N days: days 1 and 2 only
r = stats('load_w', 'energy', { days: 2 });
assert.equal(r.days, 2); near(r.value, 24, 0.3, 'last 2 days');
r = stats('load_w', 'energy', { days: 3 });
assert.equal(r.days, 3); near(r.value, (24 + 24 + 48) / 3, 0.3, 'last 3 days');
console.log('ok - the last N days');

// A day with no readings is left out, not counted as zero: day 5 and the days before day 10 have none
r = stats('load_w', 'energy');
assert.equal(r.days, 4, 'only days with readings');
// A generator that did not run reports 0 kWh: those days count as zero
r = stats('gen_kwh', 'total');
near(r.value, (0 + 5 + 0 + 7) / 4, 0.05, 'zero days count');
console.log('ok - days without readings are left out, zero days count');

// No readings, or no complete day yet
assert.match(stats('nothing', 'total').skip, /no readings/);
ins.run(at(0, 0), 'new_one', 5);
assert.match(stats('new_one', 'total').skip, /no complete days/);
console.log('ok - nothing to average yet');

// After the old readings are rolled up into 5-minute summaries (readings older than 30 days) the figures are the same
db.transaction(() => {
  for (const back of [35, 36, 37]) { fillDay('old_w', back, () => 1000); fillDay('old_v', back, () => 48 + (back - 35)); fillDay('old_kwh', back, s => 8 * s / 86400); }
})();
const cutoff = nowS - 30 * 86400;
while (runMetricsBatch(db, cutoff)) { /* one window at a time */ }
assert.equal(db.prepare('SELECT COUNT(*) n FROM metrics WHERE metric LIKE ? AND timestamp < ?').get('old_%', cutoff - (cutoff % 300)).n, 0, 'old raw rows are gone');
assert.ok(db.prepare("SELECT COUNT(*) n FROM metrics_5m WHERE metric = 'old_w'").get().n > 0, 'summaries exist');
const oldW = stats('old_w', 'energy');
near(oldW.value, 24, 0.3, 'energy from the summaries'); assert.equal(oldW.days, 3, 'days 35, 36 and 37: the first on record began at midnight, so it counts too');
near(stats('old_v', 'average').value, 49, 0.01, 'average from the summaries'); near(stats('old_kwh', 'total').value, 8, 0.06, 'totals from the summaries');
console.log('ok - the same figures from 5-minute summaries');

// evaluate(): the result is kept for the day and refreshed when the settings change
const def = { id: 'cm_t', name: 'avg', fn: 'average_per_day', inputs: ['batt_v'], daily: 'average' };
let e = cm.evaluate(def, () => null, null, nowS);
near(e.value, 53, 0.01); assert.ok(e.state && e.state.sig && /over 4 days/.test(e.note), 'a result with its state and note');
const again = cm.evaluate(def, () => null, e.state, nowS + 30);
assert.equal(again.value, e.value); assert.equal(again.state, undefined, 'reused: no state to write');
const changed = cm.evaluate({ ...def, days: 2 }, () => null, e.state, nowS + 30);
assert.ok(changed.state, 'new settings: worked out again');
const tomorrow = cm.evaluate(def, () => null, e.state, nowS + 86400);
assert.ok(tomorrow.state, 'a new day: worked out again');
const withToday = cm.evaluate({ ...def, include_today: true }, () => null, null, nowS);
assert.ok(withToday.state);
assert.equal(cm.evaluate({ ...def, include_today: true }, () => null, withToday.state, nowS + 100).state, undefined, 'including today: reused for ten minutes');
assert.ok(cm.evaluate({ ...def, include_today: true }, () => null, withToday.state, nowS + 700).state, 'then refreshed');
// the input being late or offline does not matter: it works from the history
assert.ok(Number.isFinite(cm.evaluate(def, () => null, null, nowS).value));
const missing = cm.evaluate({ ...def, inputs: ['nothing'] }, () => null, null, nowS);
assert.match(missing.skip, /no readings/);
assert.equal(cm.evaluate({ ...def, inputs: ['nothing'] }, () => null, missing.state, nowS + 60).state, undefined, 'a miss is not looked up again straight away');
console.log('ok - kept for the day, refreshed on a change');

// Validation
assert.deepEqual(cm.validateDefinition({ name: 'a', fn: 'average_per_day', inputs: ['x'], daily: 'energy', days: 30, include_today: true }), []);
assert.deepEqual(cm.validateDefinition({ name: 'a', fn: 'average_per_day', inputs: ['x'] }), [], 'the settings are optional');
assert.ok(cm.validateDefinition({ name: 'a', fn: 'average_per_day', inputs: ['x', 'y'] }).length, 'one input');
assert.ok(cm.validateDefinition({ name: 'a', fn: 'average_per_day', inputs: ['x'], daily: 'median' }).length);
for (const days of [0, -1, 1.5, 4000, 'x']) assert.ok(cm.validateDefinition({ name: 'a', fn: 'average_per_day', inputs: ['x'], days }).length, 'days ' + days);
assert.ok(cm.validateDefinition({ name: 'a', fn: 'average_per_day', inputs: ['x'], include_today: 'yes' }).length);
assert.ok(cm.validateDefinition({ name: 'a', fn: 'average_per_day', inputs: ['x'], input_unit: 'MW' }).length);
console.log('ok - validation');

// Wiring: the settings page and the save route
const ui = fs.readFileSync(path.join(REPO, 'public/js/combined-metrics.js'), 'utf8');
assert.ok(/average_per_day: \{ label: 'Average per day'/.test(ui) && /cm-daily/.test(ui) && /cm-span/.test(ui) && /cm-today/.test(ui), 'editor fields');
assert.ok(/d\.daily = v\('cm-daily'\)/.test(ui) && /d\.include_today =/.test(ui), 'read back');
assert.ok(/'daily', 'days', 'include_today'/.test(fs.readFileSync(path.join(REPO, 'server.js'), 'utf8')), 'the save route keeps the settings');

checks.done();
