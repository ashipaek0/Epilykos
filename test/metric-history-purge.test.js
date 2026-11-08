'use strict';
const checks = require('./_checks');
/**
 * Deleting a metric must not freeze the app when it has millions of stored
 * readings (a restored multi-GB database): the metric leaves the list at once,
 * its readings are removed in batches with the event loop running in between,
 * a restart finishes an interrupted purge, and a metric made again under the
 * same name keeps its new readings.
 */
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-purge-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const { deleteMetrics } = require('../modules/metricDeletion');
const purge = require('../modules/metricHistoryPurge');

const now = Math.floor(Date.now() / 1000);
const rows = name => db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE metric = ?').get(name).n;
const rollups = name => db.prepare('SELECT COUNT(*) AS n FROM metrics_5m WHERE metric = ?').get(name).n;
const BIG = purge.BATCH_ROWS * 4 + 123;

(async () => {
  const insert = db.prepare('INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const insertRollup = db.prepare('INSERT INTO metrics_5m (bucket_start, metric, value_avg, value_min, value_max, value_count) VALUES (?, ?, 1, 1, 1, 1)');
  db.transaction(() => {
    for (let i = 0; i < BIG; i++) insert.run(now - 1000 - i, 'big', i);
    for (let i = 0; i < 50; i++) { insert.run(now - 1000 - i, 'keep', i); insertRollup.run(1000 + i * 300, 'keep'); insertRollup.run(1000 + i * 300, 'big'); }
    db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, 1, ?)').run('big', now);
    db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, 1, ?)').run('keep', now);
  })();

  // The metric is gone from the list straight away; the readings are queued.
  const result = deleteMetrics(['big'], { deferHistory: true });
  assert.deepEqual(result.deleted, ['big']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM latest_metrics WHERE metric = ?').get('big').n, 0);
  assert.equal(rows('big'), BIG, 'readings are not removed in the request');
  assert.equal(purge.pending().length, 1);

  // A metric made again under the same name, with readings after the deletion.
  insert.run(now + 500, 'big', 1);

  // The event loop keeps turning while the batches run.
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  await purge.run();
  clearInterval(timer);
  assert.ok(ticks >= 2, `the event loop ran between batches (${ticks} ticks)`);
  assert.equal(rows('big'), 1, 'old readings gone, the new one kept');
  assert.equal(rollups('big'), 0, '5-minute summaries gone too');
  assert.equal(rows('keep'), 50); assert.equal(rollups('keep'), 50);
  assert.deepEqual(purge.pending(), []);
  console.log('ok - readings are purged in batches, after the metric has left the list');

  // A purge cut short by a restart is finished by resume().
  insert.run(now - 10, 'old', 1);
  database.setConfig('metric_history_purge', JSON.stringify([{ name: 'old', before: now }, { bad: true }]));
  assert.equal(purge.pending().length, 1, 'junk entries are ignored');
  await purge.resume();
  assert.equal(rows('old'), 0); assert.deepEqual(purge.pending(), []);
  await purge.resume();
  console.log('ok - an interrupted purge is finished at start-up');

  // The default, immediate behaviour still removes everything at once (tests, scripts).
  insert.run(now - 5, 'sync', 1); insertRollup.run(2000, 'sync');
  deleteMetrics(['sync']);
  assert.equal(rows('sync'), 0); assert.equal(rollups('sync'), 0);
  assert.deepEqual(purge.pending(), []);
  console.log('ok - without deferHistory the readings and summaries go immediately');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
