#!/usr/bin/env node
/**
 * test/savings-year.test.js — savings for "this year" (from 1 January), and
 * savings on days rolled up into 5-minute summaries after 30 days (the
 * retention job deletes those days' raw rows) are the same as before.
 */
'use strict';
const checks = require('./_checks');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-savings-year-')));

const { initializeDatabase, getDb, setConfig } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const { computeSavings, clearSolarValueCache } = require(path.join(REPO, 'modules/solarValue'));
const { clearDailySnapshotCache } = require(path.join(REPO, 'modules/timeseriesReader'));
const { runHistoryBatch } = require(path.join(REPO, 'modules/retentionJob'));

setConfig('savings_rate', '100');
setConfig('savings_method', 'grid');

const now = new Date(2026, 2, 10, 12);   // Tuesday 10 March 2026, noon
const at = (y, m, d, h) => Math.floor(new Date(y, m, d, h).getTime() / 1000);
const ins = db.prepare('INSERT INTO history(timestamp, solar, daily_solar) VALUES (?, ?, ?)');
// A day's counter climbs to its total, one row a minute from 06:00 to 18:00.
function day(y, m, d, total) {
  for (let t = at(y, m, d, 6); t <= at(y, m, d, 18); t += 60) ins.run(t, 1000, total * (t - at(y, m, d, 6)) / (12 * 3600));
}
day(2025, 11, 31, 10);   // last year
day(2026, 0, 5, 20);     // this year, rolled up below
day(2026, 2, 2, 5);      // this month, before this week
day(2026, 2, 9, 4);      // this week (Monday)

function savings() {
  clearDailySnapshotCache(db);
  clearSolarValueCache(db);
  return computeSavings({ todaySolarKwh: 3, db, now });
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

const before = savings();
near(before.today, 300, 'today');
near(before.week, 700, 'week: Monday + today');
near(before.month, 1200, 'month: from 1 March');
near(before.year, 3200, 'year: from 1 January');
near(before.all, 4200, 'all time');
console.log('ok - savings for today, week, month, year and all time');

// Roll up everything older than 30 days, as the retention job does.
const cutoff = Math.floor(now.getTime() / 1000) - 30 * 86400;
while (runHistoryBatch(db, cutoff)) { /* one window at a time */ }
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM history WHERE timestamp < ?').get(cutoff).n, 0, 'old raw rows are gone');
assert.ok(db.prepare('SELECT COUNT(*) n FROM history_5m').get().n > 0, 'and summarised');
const after = savings();
for (const k of ['today', 'week', 'month', 'year', 'all']) near(after[k], before[k], `${k} after the rollup`);
console.log('ok - savings are unchanged once old days are rolled up');
checks.done();
