'use strict';
const checks = require('./_checks');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-retention-rollup-'));
process.chdir(tmp);
const { initializeDatabase, getDb } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const lock = require(path.join(REPO, 'modules/maintenanceLock'));
const { runRollupOnce } = require(path.join(REPO, 'modules/retentionJob'));
const now = 2_000_000_200;
const cutoff = now - 30 * 24 * 60 * 60;
const eligible = Math.floor((cutoff - 301) / 300) * 300;

(async () => {
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(eligible, 'power', 2, null);
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(eligible + 1, 'power', 8, null);
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(eligible + 2, 'power', null, 'on');
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(eligible + 3, 'state', null, 'off');
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(cutoff - 301, 'boundary', 5, null);
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(cutoff, 'boundary', 9, null);
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(cutoff + 1, 'boundary', 10, null);
  const fields = ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc','daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export'];
  const insHistory = db.prepare(`INSERT INTO history(timestamp, ${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')}, ?)`);
  insHistory.run(eligible, 10, null, 4, null, 2, null, 50, 100, 200, 300, 400, 500, 600);
  insHistory.run(eligible + 10, 20, 6, null, 8, null, 12, null, 110, 210, 310, 410, 510, 610);
  const first = await runRollupOnce({ now });
  assert.strictEqual(first.deferred, false);
  const power = db.prepare("SELECT * FROM metrics_5m WHERE metric='power'").get();
  assert.deepStrictEqual([power.value_avg, power.value_min, power.value_max, power.value_count], [5, 2, 8, 2]);
  assert.strictEqual(db.prepare("SELECT * FROM metrics_5m WHERE metric='state'").get(), undefined);
  assert.deepStrictEqual(db.prepare("SELECT value FROM metrics WHERE metric='state'").all(), []);
  assert.strictEqual(db.prepare("SELECT value FROM metrics WHERE metric='boundary' AND timestamp=?").get(cutoff - 301), undefined, 'closed cutoff-1 row is rolled up and pruned');
  assert.strictEqual(db.prepare("SELECT value FROM metrics WHERE metric='boundary' AND timestamp=?").get(cutoff).value, 9, 'row exactly at cutoff remains raw');
  assert.strictEqual(db.prepare("SELECT value FROM metrics WHERE metric='boundary' AND timestamp=?").get(cutoff + 1).value, 10, 'row after cutoff remains raw');
  const partialTimestamp = cutoff - 1;
  db.prepare('INSERT INTO metrics(timestamp, metric, value, value_text) VALUES (?, ?, ?, ?)').run(partialTimestamp, 'partial', 99, null);
  await runRollupOnce({ now: now + 1 });
  assert.strictEqual(db.prepare("SELECT value FROM metrics WHERE metric='partial' AND timestamp=?").get(partialTimestamp).value, 99, 'older-than-cutoff row remains raw when its bucket is not fully closed');
  assert.strictEqual(db.prepare("SELECT * FROM metrics_5m WHERE metric='partial'").get(), undefined, 'partial bucket is not aggregated');
  const history = db.prepare('SELECT * FROM history_5m').get();
  const expectedInstantStats = [[15,10,20,2],[6,6,6,1],[4,4,4,1],[8,8,8,1],[2,2,2,1],[12,12,12,1],[50,50,50,1]];
  for (const [index, field] of ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc'].entries()) {
    assert.deepStrictEqual([history[`${field}_avg`], history[`${field}_min`], history[`${field}_max`], history[`${field}_count`]], expectedInstantStats[index], `${field} NULLs are excluded independently`);
  }
  for (const [field, expected] of Object.entries({ daily_consumption: 110, daily_solar: 210, daily_battery_charge: 310, daily_battery_discharge: 410, daily_grid_import: 510, daily_grid_export: 610 })) {
    assert.strictEqual(history[`${field}_last`], expected, `${field} uses the max-timestamp row`);
  }
  const before = JSON.stringify({ metrics: db.prepare('SELECT * FROM metrics_5m ORDER BY bucket_start, metric').all(), history: db.prepare('SELECT * FROM history_5m').all() });
  await runRollupOnce({ now });
  const after = JSON.stringify({ metrics: db.prepare('SELECT * FROM metrics_5m ORDER BY bucket_start, metric').all(), history: db.prepare('SELECT * FROM history_5m').all() });
  assert.strictEqual(after, before);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM metrics_5m').get().n, 2);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM history_5m').get().n, 1);
  const held = await lock.acquireLock('maintenance');
  const deferred = await runRollupOnce({ now, lockTimeoutMs: 10 });
  held();
  assert.strictEqual(deferred.deferred, true);
  console.log('ok - retention rollup aggregation, pruning boundaries, retry, and lock deferral');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
