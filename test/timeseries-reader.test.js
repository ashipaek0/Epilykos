'use strict';
const checks = require('./_checks');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-timeseries-reader-'));
process.chdir(tmp);
const { initializeDatabase, getDb } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const { readMetricSeries, readHistorySeries, readDailySnapshots } = require(path.join(REPO, 'modules/timeseriesReader'));
const now = Math.floor(Date.now() / 1000);
const cutoff = now - 30 * 24 * 60 * 60;
const bucket = Math.floor((cutoff - 600) / 300) * 300;

// Raw-only metrics/history are returned within the exclusive query window.
db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(cutoff + 10, 'raw', 1);
db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(cutoff + 20, 'raw', 2);
assert.deepStrictEqual(readMetricSeries(db, { metric: 'raw', from: cutoff, to: cutoff + 20 }), [
  { timestamp: cutoff + 10, value: 1, count: 1 }
]);

// Mixed rolled/raw series, partial overlap, and exact-bucket defensive suppression.
db.prepare('INSERT INTO metrics_5m VALUES (?, ?, ?, ?, ?, ?)').run(bucket, 'mixed', 5, 2, 8, 3);
db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(bucket + 120, 'mixed', 777);
db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(cutoff + 10, 'mixed', 9);
assert.deepStrictEqual(readMetricSeries(db, { metric: 'mixed', from: bucket + 299, to: cutoff + 11 }), [
  { timestamp: bucket, value: 5, count: 3 }, { timestamp: cutoff + 10, value: 9, count: 1 }
]);
assert.deepStrictEqual(readMetricSeries(db, { metric: 'mixed', from: bucket, to: bucket }), []);
assert.deepStrictEqual(readMetricSeries(db, { metric: 'mixed', from: bucket, to: bucket, toInclusive: true }), [
  { timestamp: bucket, value: 5, count: 3 }
]);
assert.deepStrictEqual(readMetricSeries(db, { metric: 'raw', from: cutoff + 10, to: cutoff + 20, toInclusive: true }), [
  { timestamp: cutoff + 10, value: 1, count: 1 }, { timestamp: cutoff + 20, value: 2, count: 1 }
]);

// History instant fields use *_avg/count; daily fields use *_last; unrequested columns are absent.
const histBucket = Math.floor((cutoff - 300) / 300) * 300;
db.prepare(`INSERT INTO history_5m (bucket_start, consumption_avg, consumption_count, solar_count, battery_charge_count, battery_discharge_count, grid_import_count, grid_export_count, battery_soc_count, daily_solar_last) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, ?)`).run(histBucket, 12, 4, 55);
db.prepare('INSERT INTO history(timestamp, consumption, solar, daily_solar) VALUES (?, ?, ?, ?)').run(cutoff + 30, 3, 4, 66);
assert.deepStrictEqual(readHistorySeries(db, { from: histBucket, to: cutoff + 30, toInclusive: true, fields: ['consumption', 'daily_solar'] }), [
  { timestamp: histBucket, consumption: 12, consumption_count: 4, daily_solar: 55 },
  { timestamp: cutoff + 30, consumption: 3, consumption_count: 1, daily_solar: 66 }
]);
assert.deepStrictEqual(readHistorySeries(db, { from: now + 1, to: now + 10, fields: ['solar'] }), []);

// Daily MAX combines raw and aggregate values grouped by the shared local-day expression.
const day1 = Math.floor((cutoff - 900) / 86400) * 86400;
const day2 = day1 + 86400;
db.prepare('INSERT INTO history(timestamp, daily_solar) VALUES (?, ?)').run(day1 + 10, 7);
db.prepare('INSERT INTO history(timestamp, daily_solar) VALUES (?, ?)').run(day1 + 20, 11);
db.prepare(`INSERT INTO history_5m (bucket_start, consumption_count, solar_count, battery_charge_count, battery_discharge_count, grid_import_count, grid_export_count, battery_soc_count, daily_solar_last) VALUES (?, 0, 0, 0, 0, 0, 0, 0, ?)`).run(day1 + 300, 9);
db.prepare('INSERT INTO history(timestamp, daily_solar) VALUES (?, ?)').run(day2 + 10, 4);
const { SQL_LOCAL_DAY } = require(path.join(REPO, 'modules/localTime'));
assert.strictEqual(SQL_LOCAL_DAY, "date(timestamp, 'unixepoch', 'localtime')");
assert.deepStrictEqual(readDailySnapshots(db, { from: day1, to: day2 + 10, toInclusive: true, fields: ['daily_solar'] }), [
  { day: db.prepare("SELECT date(?, 'unixepoch', 'localtime') day").get(day1).day, daily_solar: 66 },
  { day: db.prepare("SELECT date(?, 'unixepoch', 'localtime') day").get(day2).day, daily_solar: 4 }
]);
assert.deepStrictEqual(readMetricSeries(db, { metric: 'absent', from: now, to: now + 1 }), []);
assert.deepStrictEqual(readHistorySeries(db, { from: now, to: now + 1, fields: ['solar'] }), []);
assert.deepStrictEqual(readDailySnapshots(db, { from: now, to: now + 1, fields: ['daily_solar'] }), []);
console.log('ok - timeseries reader raw, rollup, boundaries, history mapping, local-day snapshots, and empty tables');
checks.done();
