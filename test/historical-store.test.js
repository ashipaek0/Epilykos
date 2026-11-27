'use strict';
const checks = require('./_checks');
/**
 * modules/historicalStore.js stores past readings from another database (an InfluxDB import) in the dashboard's own
 * tables: older than 30 days as 5-minute buckets, newer as raw readings, the dashboard's own readings always winning per
 * (metric, 5-minute bucket), and a second run storing nothing new. Also: onMetricsFlushed listeners get the stored rows.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-historical-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const { storeHistoricalBatch } = require('../modules/historicalStore');
const { readMetricSeries } = require('../modules/timeseriesReader');

const NOW = Math.floor(Date.now() / 1000 / 300) * 300;   // a 5-minute boundary (the reader uses the real clock)
const DAY = 86400;
const old = NOW - 40 * DAY;                       // beyond the 30-day raw retention
const recent = NOW - 2 * DAY;

// ── Old raw points fold into buckets; recent ones stay raw ──────────────
let r = storeHistoricalBatch(db, { points: [
  { metric: 'pv', timestamp: old, value: 100 },
  { metric: 'pv', timestamp: old + 60, value: 200 },
  { metric: 'pv', timestamp: old + 120, value: 300 },
  { metric: 'pv', timestamp: recent, value: 50 },
  { metric: 'pv', timestamp: recent + 30, value: 70 },
] }, { now: NOW });
assert.deepStrictEqual([r.buckets, r.raw, r.skipped, r.invalid], [1, 2, 0, 0], JSON.stringify(r));
const b = db.prepare('SELECT * FROM metrics_5m WHERE metric = ?').get('pv');
assert.deepStrictEqual([b.bucket_start, b.value_avg, b.value_min, b.value_max, b.value_count], [old, 200, 100, 300, 3]);
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metrics WHERE metric = ?').get('pv').n, 2);
assert.deepStrictEqual(db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get('pv'), { value: 70, timestamp: recent + 30 },
  'a metric the dashboard has never seen is listed, with its newest imported reading');

// ── Running it again stores nothing new ─────────────────────────────────
r = storeHistoricalBatch(db, { points: [{ metric: 'pv', timestamp: old + 30, value: 999 }, { metric: 'pv', timestamp: recent + 60, value: 999 }] }, { now: NOW });
assert.deepStrictEqual([r.buckets, r.raw, r.skipped], [0, 0, 2], 'buckets already filled are left as they are');

// ── The dashboard's own readings win ────────────────────────────────────
db.prepare('INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)').run(recent + 600, 'load', 400);
db.prepare('INSERT INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run('load', 999, NOW);
db.prepare('INSERT INTO metrics_5m (bucket_start, metric, value_avg, value_min, value_max, value_count) VALUES (?, ?, ?, ?, ?, ?)').run(old, 'load', 10, 10, 10, 1);
r = storeHistoricalBatch(db, { points: [
  { metric: 'load', timestamp: recent + 650, value: 1 },          // same 5-minute bucket as a local raw reading
  { metric: 'load', timestamp: recent + 900, value: 2 },          // the next bucket: free
  { metric: 'load', timestamp: old + 10, value: 3 },              // same bucket as a local roll-up
] }, { now: NOW });
assert.deepStrictEqual([r.raw, r.buckets, r.skipped], [1, 0, 2], JSON.stringify(r));
assert.strictEqual(db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('load').value, 999, 'an existing latest value is never replaced');
assert.strictEqual(db.prepare('SELECT value_avg FROM metrics_5m WHERE metric = ? AND bucket_start = ?').get('load', old).value_avg, 10);

// ── Pre-bucketed input (from the source's own aggregation) ──────────────
r = storeHistoricalBatch(db, { buckets: [
  { metric: 'soc', bucket_start: old, avg: 50, min: 40, max: 60, count: 10 },
  { metric: 'soc', bucket_start: recent, avg: 70, min: 70, max: 70, count: 1 },     // inside retention → one raw reading of the mean
  { metric: 'soc', bucket_start: old + 7, avg: 1, min: 1, max: 1, count: 1 },       // not on a boundary
  { metric: 'soc', bucket_start: old + 300, avg: 9, min: 10, max: 20, count: 1 },   // mean outside min..max
  { metric: 'soc', bucket_start: old + 600, avg: 5, min: 5, max: 5, count: 0 },     // no readings
] }, { now: NOW });
assert.deepStrictEqual([r.buckets, r.raw, r.invalid], [1, 1, 3], JSON.stringify(r));
assert.strictEqual(db.prepare('SELECT value FROM metrics WHERE metric = ? AND timestamp = ?').get('soc', recent).value, 70);

// ── Bad input is counted, never stored ──────────────────────────────────
r = storeHistoricalBatch(db, { points: [
  { metric: '', timestamp: old, value: 1 }, { metric: 'x', timestamp: NaN, value: 1 }, { metric: 'x', timestamp: old, value: 'on' },
  { metric: 'x', timestamp: NOW + 60, value: 1 }, null,
] }, { now: NOW });
assert.deepStrictEqual([r.raw, r.buckets, r.invalid], [0, 0, 5]);
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM latest_metrics WHERE metric = ?').get('x').n, 0);

// ── The reader joins both halves ────────────────────────────────────────
const series = readMetricSeries(db, { metric: 'pv', from: old - DAY, to: NOW, toInclusive: true });
assert.deepStrictEqual(series.map(p => p.value), [200, 50, 70], 'old bucket, then recent raw readings');

// ── onMetricsFlushed passes the stored rows ─────────────────────────────
(async () => {
  const seen = [];
  const off = database.onMetricsFlushed((n, rows) => seen.push([n, rows.map(x => [x.metric, x.value])]));
  database.queueMetricWrite({ metric: 'grid', value: 5, timestamp: NOW });
  database.flushMetrics();
  await new Promise(res => setImmediate(res));
  off();
  assert.deepStrictEqual(seen, [[1, [['grid', 5]]]]);
  console.log('ok - historical store');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
