#!/usr/bin/env node
/**
 * test/timeseries-routing-solar.test.js — Phase 4b: modules/solar.js
 * computeSolarForDate() and computeTodaySolar()'s 3 raw query paths
 * (configured-metric integration, auto-detect power-metric integration,
 * history-table fallback) routed through modules/timeseriesReader.js.
 *
 * Each path gets a BACKWARD COMPAT case (raw-only data, diffed against a
 * reference computation using the exact pre-routing SQL/algorithm) and a
 * BOUNDARY case (rollup bucket + raw row both inside the query window).
 *
 * computeTodaySolar() keeps a 30s in-process value cache (solarCache) with
 * no test-clear hook, so each of its cases runs in its own child process
 * (same isolation technique as test/appliance-mode.test.js) — this also
 * matches the fixture's own fresh-DB-per-case requirement.
 */
'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

// Reference trapezoidal integration — the exact pre-routing algorithm, kept
// independently here so a bug introduced in timeseriesReader.js or its
// wiring would show up as a mismatch, not get rubber-stamped by reuse.
function referenceIntegrate(rows, endUnix) {
  let totalKwh = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const dtHours = (rows[i + 1].timestamp - rows[i].timestamp) / 3600;
    const avgKw = (rows[i].value + rows[i + 1].value) / 2000;
    totalKwh += avgKw * dtHours;
  }
  const last = rows[rows.length - 1];
  const dtLastHours = (endUnix - last.timestamp) / 3600;
  if (dtLastHours > 0) totalKwh += (last.value / 1000) * dtLastHours;
  return totalKwh;
}

// ================= computeSolarForDate (no cache — same process is fine) =================

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-ts-solar-'));
process.chdir(tmp);
const { initializeDatabase, getDb } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const solar = require(path.join(REPO, 'modules/solar'));

check('computeSolarForDate: raw-only history.solar matches pre-routing reference integration', () => {
  // "today" so startUnix stays within the 30-day retention window (readHistorySeries
  // excludes raw rows older than the cutoff — computeSolarForDate is called for
  // recent dates in production, so that's the realistic case to cover here).
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const startUnix = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
  const endUnix = Math.floor(new Date(dateStr + 'T23:59:59').getTime() / 1000);
  const fields = ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc','daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export'];
  const insHistory = db.prepare(`INSERT INTO history(timestamp, ${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')}, ?)`);
  const rawRows = [
    { timestamp: startUnix + 3600, solar: 1000 },
    { timestamp: startUnix + 7200, solar: 2000 },
    { timestamp: startUnix + 10800, solar: 1500 }
  ];
  for (const r of rawRows) insHistory.run(r.timestamp, 0, r.solar, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

  const actual = solar.computeSolarForDate(dateStr);
  const expected = referenceIntegrate(rawRows.map(r => ({ timestamp: r.timestamp, value: r.solar })), endUnix);
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

check('computeSolarForDate: rollup bucket + raw row merge at the raw/aggregate boundary', () => {
  // Aggregate (history_5m) buckets only exist for data OLDER than the 30-day
  // retention cutoff (that's what the rollup job is for); raw rows only
  // exist for data AT/AFTER the cutoff. Anchor both timestamps directly to
  // the cutoff instant itself (not an arbitrary calendar day) so each lands
  // on its expected side of the boundary with certainty.
  const RETENTION_SECONDS = 30 * 24 * 60 * 60;
  const cutoffNow = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
  const cutoffDate = new Date(cutoffNow * 1000);
  const dateStr = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;
  const startUnix = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
  const endUnix = Math.floor(new Date(dateStr + 'T23:59:59').getTime() / 1000);
  // Aggregate bucket just BEFORE the cutoff (old enough to be rolled up).
  const bucket = cutoffNow - 1000;
  db.prepare(`INSERT INTO history_5m (bucket_start, solar_avg, solar_min, solar_max, solar_count, consumption_count, battery_charge_count, battery_discharge_count, grid_import_count, grid_export_count, battery_soc_count) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`)
    .run(bucket, 500, 400, 600, 10);
  // Raw row just AT/AFTER the cutoff (recent enough to still be raw), same local day.
  const rawTs = cutoffNow + 1000;
  const fields = ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc','daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export'];
  db.prepare(`INSERT INTO history(timestamp, ${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')}, ?)`)
    .run(rawTs, 0, 900, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

  const actual = solar.computeSolarForDate(dateStr);
  const expected = referenceIntegrate([{ timestamp: bucket, value: 500 }, { timestamp: rawTs, value: 900 }], endUnix);
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

// ================= computeTodaySolar (child process per case: 30s cache, needs a fresh DB each time) =================

function runComputeTodaySolar(setupCode) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-ts-solar-today-'));
  const code = `
    const db = require(${JSON.stringify(path.join(REPO, 'modules/database'))});
    db.initializeDatabase();
    const sqliteDb = db.getDb();
    ${setupCode}
    const solar = require(${JSON.stringify(path.join(REPO, 'modules/solar'))});
    const result = solar.computeTodaySolar();
    console.log('RESULT ' + JSON.stringify({ result }));
  `;
  const r = spawnSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  const line = r.stdout.trim().split('\n').filter(l => l.startsWith('RESULT ')).pop();
  if (!line) throw new Error(`no RESULT line:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7)).result;
}

check('computeTodaySolar path 1 (configured metric power integration): raw-only matches pre-routing reference', () => {
  const metric = 'configured_solar_power';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  const rawRows = [
    { timestamp: startUnix + 60, value: 500 },
    { timestamp: startUnix + 120, value: 1500 }
  ];
  const setup = `
    db.setConfig('savings_solar_metric', ${JSON.stringify(metric)});
    sqliteDb.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value) VALUES (?, ?)').run(${JSON.stringify(metric)}, 0);
    ${rawRows.map(r => `sqliteDb.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(${r.timestamp}, ${JSON.stringify(metric)}, ${r.value});`).join('\n')}
  `;
  const actual = runComputeTodaySolar(setup);
  const expected = referenceIntegrate(rawRows, endUnix);
  assert.ok(Math.abs(actual - expected) < 5e-3, `expected ${expected}, got ${actual}`);
});

check('computeTodaySolar path 1: an aggregate bucket seeded inside today\'s window is correctly ignored (cutoff is 30 days back, never within "today") — only raw data drives the result', () => {
  // ARCHITECTURAL NOTE: computeTodaySolar's query window is always
  // [start-of-today, now) -- at most ~24h wide. The raw/aggregate cutoff is
  // 30 days back. Those two facts mean a real aggregate bucket can NEVER
  // fall inside today's window in production (cutoff is always far outside
  // the window). This test proves readMetricSeries/the wiring honours that:
  // an aggregate bucket planted inside today's window (an artificial state
  // that should never occur, but must not corrupt the result if it did) is
  // excluded from the raw-vs-aggregate split because it fails the
  // `bucket_start <= min(to, cutoff)` guard, so only the raw row is counted.
  const metric = 'configured_solar_power_b';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  const bucket = startUnix + 60; // inside today's window, but NOT old enough to be a real rollup
  const rawTs = endUnix;
  const setup = `
    db.setConfig('savings_solar_metric', ${JSON.stringify(metric)});
    sqliteDb.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value) VALUES (?, ?)').run(${JSON.stringify(metric)}, 0);
    sqliteDb.prepare('INSERT INTO metrics_5m(bucket_start, metric, value_avg, value_min, value_max, value_count) VALUES (?, ?, ?, ?, ?, ?)').run(${bucket}, ${JSON.stringify(metric)}, 800, 700, 900, 5);
    sqliteDb.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(${rawTs}, ${JSON.stringify(metric)}, 1200);
  `;
  const actual = runComputeTodaySolar(setup);
  // Only the raw row counts: a single-point series integrates to 0 (no
  // interval to integrate over before "now" IS the last point).
  const expected = referenceIntegrate([{ timestamp: rawTs, value: 1200 }], endUnix);
  assert.ok(Math.abs(actual - expected) < 5e-3, `expected ${expected}, got ${actual}`);
});

check('computeTodaySolar path 2b (auto-detect solar power metric): raw-only matches pre-routing reference', () => {
  const metric = 'inverter_solar_power_watts';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  const rawRows = [
    { timestamp: startUnix + 30, value: 300 },
    { timestamp: startUnix + 90, value: 700 }
  ];
  const setup = `
    db.setConfig('savings_solar_metric', '');
    sqliteDb.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value) VALUES (?, ?)').run(${JSON.stringify(metric)}, 123);
    ${rawRows.map(r => `sqliteDb.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(${r.timestamp}, ${JSON.stringify(metric)}, ${r.value});`).join('\n')}
  `;
  const actual = runComputeTodaySolar(setup);
  const expected = referenceIntegrate(rawRows, endUnix);
  assert.ok(Math.abs(actual - expected) < 5e-3, `expected ${expected}, got ${actual}`);
});

check('computeTodaySolar path 2b: an aggregate bucket seeded inside today\'s window is correctly ignored (same architectural invariant as path 1)', () => {
  const metric = 'inverter_solar_power_watts_b';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  const bucket = startUnix + 30;
  const rawTs = endUnix;
  const setup = `
    db.setConfig('savings_solar_metric', '');
    sqliteDb.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value) VALUES (?, ?)').run(${JSON.stringify(metric)}, 123);
    sqliteDb.prepare('INSERT INTO metrics_5m(bucket_start, metric, value_avg, value_min, value_max, value_count) VALUES (?, ?, ?, ?, ?, ?)').run(${bucket}, ${JSON.stringify(metric)}, 350, 300, 400, 5);
    sqliteDb.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)').run(${rawTs}, ${JSON.stringify(metric)}, 950);
  `;
  const actual = runComputeTodaySolar(setup);
  const expected = referenceIntegrate([{ timestamp: rawTs, value: 950 }], endUnix);
  assert.ok(Math.abs(actual - expected) < 5e-3, `expected ${expected}, got ${actual}`);
});

check('computeTodaySolar path 4 (history-table fallback): raw-only history.solar matches pre-routing reference', () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  const rawRows = [
    { timestamp: startUnix + 45, solar: 400 },
    { timestamp: startUnix + 100, solar: 900 }
  ];
  const fields = ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc','daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export'];
  const setup = `
    db.setConfig('savings_solar_metric', '');
    const fields = ${JSON.stringify(fields)};
    const ins = sqliteDb.prepare('INSERT INTO history(timestamp, ' + fields.join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ', ?)');
    ${rawRows.map(r => `ins.run(${r.timestamp}, 0, ${r.solar}, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);`).join('\n')}
  `;
  const actual = runComputeTodaySolar(setup);
  const expected = referenceIntegrate(rawRows.map(r => ({ timestamp: r.timestamp, value: r.solar })), endUnix);
  assert.ok(Math.abs(actual - expected) < 5e-3, `expected ${expected}, got ${actual}`);
});

check('computeTodaySolar path 4: an aggregate bucket seeded inside today\'s window is correctly ignored (history_5m rollups predate the 30-day cutoff, never within "today")', () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  const bucket = startUnix + 45;
  const rawTs = endUnix;
  const fields = ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc','daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export'];
  const setup = `
    db.setConfig('savings_solar_metric', '');
    sqliteDb.prepare('INSERT INTO history_5m (bucket_start, solar_avg, solar_min, solar_max, solar_count, consumption_count, battery_charge_count, battery_discharge_count, grid_import_count, grid_export_count, battery_soc_count) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)').run(${bucket}, 600, 500, 700, 8);
    const fields = ${JSON.stringify(fields)};
    const ins = sqliteDb.prepare('INSERT INTO history(timestamp, ' + fields.join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ', ?)');
    ins.run(${rawTs}, 0, 1100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  `;
  const actual = runComputeTodaySolar(setup);
  const expected = referenceIntegrate([{ timestamp: rawTs, value: 1100 }], endUnix);
  assert.ok(Math.abs(actual - expected) < 5e-3, `expected ${expected}, got ${actual}`);
});

console.log(`\ntimeseries-routing-solar.test.js: ${passed} checks passed`);
