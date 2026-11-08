'use strict';
/**
 * Removing a metric's stored readings without freezing the app.
 *
 * The readings table can hold tens of millions of rows for one metric (a
 * restored multi-GB database does), and SQLite deletes them one by one. As a
 * single statement that blocks the whole process for a minute or more: the
 * page hangs, polling cycles are skipped and device reads time out. Here the
 * rows go in small batches with a turn of the event loop between them.
 *
 * Deleting a metric removes it from the list and the settings at once; its
 * history is purged afterwards. Pending names are kept in the config so a
 * restart finishes the job. Only rows up to the time of the deletion are
 * purged, so a metric created again under the same name keeps its new readings.
 */
const { getDb, getConfig, setConfig } = require('./database');
const { logger } = require('./logger');

const KEY = 'metric_history_purge';
const BATCH_ROWS = 5000;

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

function pending() {
  try { const list = JSON.parse(getConfig(KEY) || '[]'); return Array.isArray(list) ? list.filter(e => e && typeof e.name === 'string') : []; }
  catch (_) { return []; }
}
function savePending(list) { setConfig(KEY, JSON.stringify(list)); }

let running = null;

async function purgeOne(entry) {
  const db = getDb();
  const readings = db.prepare('DELETE FROM metrics WHERE rowid IN (SELECT rowid FROM metrics WHERE metric = ? AND timestamp <= ? LIMIT ?)');
  const rollups = db.prepare('DELETE FROM metrics_5m WHERE rowid IN (SELECT rowid FROM metrics_5m WHERE metric = ? AND bucket_start <= ? LIMIT ?)');
  let removed = 0;
  for (const statement of [readings, rollups]) {
    for (;;) {
      const { changes } = statement.run(entry.name, entry.before, BATCH_ROWS);
      removed += changes;
      if (changes < BATCH_ROWS) break;
      await yieldToEventLoop();
    }
  }
  return removed;
}

/** Works through the pending list, one metric at a time. Never throws. */
function run() {
  if (running) return running;
  running = (async () => {
    try {
      for (;;) {
        const [next] = pending();
        if (!next) break;
        const started = Date.now();
        const removed = await purgeOne(next);
        savePending(pending().filter(e => !(e.name === next.name && e.before === next.before)));
        if (removed > 10000) logger.info(`Metrics: removed ${removed} stored readings of "${next.name}" in ${Math.round((Date.now() - started) / 1000)} s`);
        await yieldToEventLoop();
      }
    } catch (error) {
      logger.error(`Metric history purge stopped: ${error.message}`);
    } finally { running = null; }
  })();
  return running;
}

/** Queue the stored readings of these deleted metrics for removal and start. */
function schedule(names) {
  const before = Math.floor(Date.now() / 1000);
  const list = pending();
  for (const name of names) list.push({ name, before });
  savePending(list);
  // Not inside the request that deleted the metric.
  setImmediate(run);
}

/** At start-up, and after a restore: finish what an earlier run left. */
function resume() { return pending().length ? run() : Promise.resolve(); }

module.exports = { schedule, resume, pending, run, BATCH_ROWS };
