'use strict';
const checks = require('./_checks');
// Daily totals across midnight. A source's daily counter carries yesterday's
// final total into the new day until it resets (its own clock decides when),
// or for as long as the source is offline. Taken as the day's maximum, that
// made the daily summary and the dashboard report yesterday's energy as
// today's. Both the reader (existing rows) and the history writer (new rows)
// must keep the carry-over out of the new day.
process.env.TZ = 'Africa/Lagos';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-carryover-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');

const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const { readDailySnapshots } = require('../modules/timeseriesReader');
const history = require('../modules/history');
const { localDateString } = require('../modules/localTime');

const now = new Date();
const midnight = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
const H = 3600;
const today = localDateString(new Date(midnight * 1000 + 12 * H * 1000));
const yesterday = localDateString(new Date((midnight - 12 * H) * 1000));
const FIELDS = ['daily_consumption', 'daily_solar', 'daily_grid_import'];

const ins = db.prepare('INSERT OR REPLACE INTO history (timestamp, daily_consumption, daily_solar, daily_grid_import) VALUES (?, ?, ?, ?)');
function day(start, rows) { for (const [h, c, s, g] of rows) ins.run(start + Math.round(h * H), c, s, g); }

(async () => {
  // Yesterday: rises to 20 kWh used, 25 kWh solar, 6 kWh from the grid.
  day(midnight - 24 * H, [[0.5, 0.1, 0, 0], [6, 3, 0, 2], [12, 9, 12, 3], [18, 15, 24, 5], [23.99, 20, 25, 6]]);
  // Today: the inverter still shows yesterday's totals for 25 minutes (late
  // reset), then counts again; by 21:00 less was used than yesterday.
  day(midnight, [[0.01, 20, 25, 6], [0.2, 20, 25, 6], [0.42, 20.1, 25, 6], [0.5, 0.2, 0, 0.1], [9, 4, 7, 1], [21, 8, 15, 2]]);

  let rows = readDailySnapshots(db, { from: midnight, to: midnight + 24 * H - 1, toInclusive: true, fields: FIELDS });
  assert.deepEqual(rows.map(r => r.day), [today], 'the look-back day is not returned');
  assert.deepEqual([rows[0].daily_consumption, rows[0].daily_solar, rows[0].daily_grid_import], [8, 15, 2], "today's own totals, not yesterday's carried over");
  rows = readDailySnapshots(db, { from: midnight - 24 * H, to: midnight - 1, toInclusive: true, fields: FIELDS });
  assert.deepEqual([rows[0].day, rows[0].daily_consumption, rows[0].daily_solar], [yesterday, 20, 25], "yesterday's totals are unchanged");
  const all = readDailySnapshots(db, { fields: FIELDS });
  assert.deepEqual(all.map(r => [r.day, r.daily_consumption]), [[yesterday, 20], [today, 8]], 'all-time reads agree');
  console.log('ok - reader: early-day values at or above the previous day\'s final total are carry-over');

  // A day that really ends higher keeps every value; a counter that never
  // resets still counts after the first two hours.
  db.prepare('DELETE FROM history').run();
  day(midnight - 24 * H, [[23.9, 5, 5, 1]]);
  day(midnight, [[1, 0.5, 0, 0.1], [10, 30, 6, 2]]);
  rows = readDailySnapshots(db, { from: midnight, to: midnight + 24 * H - 1, toInclusive: true, fields: FIELDS });
  assert.deepEqual([rows[0].daily_consumption, rows[0].daily_solar], [30, 6]);
  db.prepare('DELETE FROM history').run();
  day(midnight - 24 * H, [[23.9, 100, 0, 0]]);
  day(midnight, [[0.5, 100, 0, 0], [3, 101, 0, 0]]);
  rows = readDailySnapshots(db, { from: midnight, to: midnight + 24 * H - 1, toInclusive: true, fields: ['daily_consumption'] });
  assert.equal(rows[0].daily_consumption, 101, 'a never-resetting counter is still read after two hours');
  console.log('ok - reader: genuine totals and never-resetting counters are kept');

  // The daily summary built from it.
  db.prepare('DELETE FROM history').run();
  day(midnight - 24 * H, [[23.99, 20, 25, 6]]);
  day(midnight, [[0.01, 20, 25, 6], [0.5, 0.2, 0, 0.1], [21, 8, 15, 2]]);
  const reports = require('../modules/notifications/reports');
  const y = await reports.daySummary('yesterday');
  assert.match(y.body, /Used: 20 kWh/);
  const t = await reports.daySummary('today');
  assert.match(t.body, /Used: 8 kWh/, t.body);
  assert.doesNotMatch(t.body, /Used: 20 kWh/);
  console.log('ok - daily summary: today and yesterday each report their own totals');

  // Writer: what goes into history from the sources' last values.
  db.prepare('DELETE FROM history').run();
  database.setConfig('role_metrics', JSON.stringify({ daily_consumption: 'load_today', daily_solar: 'pv_today' }));
  const latest = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  const realNow = Date.now;
  const pollAt = async s => { Date.now = () => s * 1000; try { await history.pollLegacyHistory(); } finally { Date.now = realNow; } };
  const written = s => db.prepare('SELECT daily_consumption, daily_solar FROM history WHERE timestamp = ?').get(s);
  day(midnight - 24 * H, [[23.99, 20, 25, 0]]);
  history.resetCarryOverForTests();

  latest.run('load_today', 20, midnight - 60); latest.run('pv_today', 25, midnight - 60);
  await pollAt(midnight + 300);
  assert.deepEqual(written(midnight + 300), { daily_consumption: 0, daily_solar: 0 }, 'last reported yesterday: not today\'s energy');
  latest.run('load_today', 20.1, midnight + 400); latest.run('pv_today', 25, midnight + 400);
  await pollAt(midnight + 420);
  assert.deepEqual(written(midnight + 420), { daily_consumption: 0, daily_solar: 0 }, 'reported today but not reset yet');
  latest.run('load_today', 0.3, midnight + 1800); latest.run('pv_today', 0, midnight + 1800);
  await pollAt(midnight + 1830);
  assert.deepEqual(written(midnight + 1830), { daily_consumption: 0.3, daily_solar: 0 }, 'after the reset it records');
  latest.run('load_today', 22, midnight + 3 * H); latest.run('pv_today', 26, midnight + 3 * H);
  await pollAt(midnight + 3 * H + 30);
  assert.deepEqual(written(midnight + 3 * H + 30), { daily_consumption: 22, daily_solar: 26 }, 'after two hours any value is taken');
  console.log('ok - writer: stale and not-yet-reset daily counters are written as 0, then recorded normally');

  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
