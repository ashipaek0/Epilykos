#!/usr/bin/env node
/**
 * test/timeseries-routing-metrics.test.js — Phase 4b: modules/metrics.js
 * getMetricHistory() routed through modules/timeseriesReader.js.
 *
 * Proves two things for this one call site:
 *  1. BACKWARD COMPAT — with only raw `metrics` rows seeded (empty
 *     metrics_5m), the routed function returns byte-identical output to the
 *     pre-routing query (`SELECT timestamp, value FROM metrics WHERE
 *     metric = ? AND timestamp >= ? ORDER BY timestamp ASC`), diffed against
 *     a reference computation kept in this test.
 *  2. BOUNDARY MERGE — with a rolled-up 5-min bucket AND a non-overlapping
 *     raw row both inside the requested window, the merged output is correct
 *     (rollup wins its own bucket, raw rows outside any rolled bucket pass
 *     through untouched).
 */
'use strict';
const checks = require('./_checks');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-ts-metrics-'));
process.chdir(tmp);

const { initializeDatabase, getDb } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const { getMetricHistory } = require(path.join(REPO, 'modules/metrics'));

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

const now = Math.floor(Date.now() / 1000);

// ---- 1. Backward compat: raw-only data, reference = pre-routing SQL ----
check('getMetricHistory: raw-only data matches pre-routing reference query', () => {
  const metric = 'compat_power';
  const hours = 6;
  const since = now - hours * 3600;
  // Seed raw rows: some inside the window, one outside (older than `since`).
  db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(since - 100, metric, 999); // outside
  db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(since + 10, metric, 100);
  db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(since + 500, metric, 200);
  db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(now, metric, 300);

  const actual = getMetricHistory(metric, hours);

  // Reference: the EXACT pre-routing query (no upper bound, inclusive lower bound).
  const referenceRows = db.prepare(
    'SELECT timestamp, value FROM metrics WHERE metric = ? AND timestamp >= ? ORDER BY timestamp ASC'
  ).all(metric, since);
  const reference = referenceRows.map(r => ({ timestamp: r.timestamp * 1000, value: r.value }));

  assert.deepStrictEqual(actual, reference, 'routed output must equal the pre-routing reference query');
  assert.strictEqual(actual.length, 3, 'exactly the 3 in-window rows');
});

// ---- 2. Boundary merge: rollup bucket + raw row in the same window ----
// metrics_5m only holds buckets older than the 30-day retention cutoff, so
// the aggregate bucket must sit near that cutoff for readMetricSeries to
// consider it (a bucket near "now" would never be queried from metrics_5m).
check('getMetricHistory: rollup bucket + raw row merge correctly at the raw/aggregate boundary', () => {
  const metric = 'boundary_power';
  const RETENTION_SECONDS = 30 * 24 * 60 * 60;
  const cutoff = now - RETENTION_SECONDS;
  const hours = Math.ceil(RETENTION_SECONDS / 3600) + 1; // window wide enough to reach the cutoff
  const since = now - hours * 3600;
  const bucket = Math.floor((cutoff - 600) / 300) * 300; // a closed 5-min bucket just before the cutoff
  // Aggregate bucket: avg=42, count=5 (as if 5 raw points were rolled up).
  db.prepare('INSERT INTO metrics_5m(bucket_start, metric, value_avg, value_min, value_max, value_count) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bucket, metric, 42, 40, 44, 5);
  // A raw row OUTSIDE that bucket's 300s span, still inside the window (recent, post-cutoff).
  const rawTs = now - 60;
  db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(rawTs, metric, 77);

  const rows = getMetricHistory(metric, hours);
  assert.deepStrictEqual(rows, [
    { timestamp: bucket * 1000, value: 42 },
    { timestamp: rawTs * 1000, value: 77 }
  ], 'rollup bucket (avg) and raw row merge in chronological order');
});

console.log(`\ntimeseries-routing-metrics.test.js: ${passed} checks passed`);
checks.done();
