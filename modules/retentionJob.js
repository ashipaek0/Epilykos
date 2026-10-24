'use strict';

const { getDb } = require('./database');
const { acquireLock } = require('./maintenanceLock');
const { logger } = require('./logger');

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const BUCKET_SECONDS = 300;
const BUDGET_MS = 2000;              // work per run before yielding the maintenance lock
const CATCH_UP_MS = 10 * 1000;       // next run while a backlog remains
const FIRST_RUN_MS = 60 * 1000;      // after start-up settles
const INSTANT_FIELDS = ['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc', 'generator'];
const DAILY_FIELDS = ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export', 'daily_generator'];

function bucketOf(timestamp) {
  return Math.floor(timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
}

// Work is done in windows of raw rows, read and deleted by timestamp range
// (the tables' primary key), so a batch never scans the whole table: on a
// multi-GB database the old per-group queries took seconds per batch on the
// main thread. A window holds whole 5-minute buckets that closed before the
// cutoff; a bucket still open at the cutoff stays raw.
const WINDOW_SECONDS = 3600;

/** [start, end) of the next window of `table` to roll up, or null when none is due. */
function nextWindow(db, table, cutoff) {
  const closedEnd = bucketOf(cutoff);
  const oldest = db.prepare(`SELECT MIN(timestamp) AS t FROM ${table}`).get().t;
  if (oldest === null || oldest === undefined || oldest >= closedEnd) return null;
  const start = bucketOf(oldest);
  return [start, Math.min(start + WINDOW_SECONDS, closedEnd)];
}

/**
 * Roll up one window of `metrics` into metrics_5m and delete it. Returns
 * the number of (bucket, metric) groups seen; 0 when nothing is due. Text
 * values have no aggregate and are pruned with the window.
 */
function runMetricsBatch(db, cutoff) {
  const upsert = db.prepare(`INSERT INTO metrics_5m (bucket_start, metric, value_avg, value_min, value_max, value_count)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bucket_start, metric) DO UPDATE SET
    value_avg=(value_avg * value_count + excluded.value_avg * excluded.value_count) / (value_count + excluded.value_count),
    value_min=min(value_min, excluded.value_min), value_max=max(value_max, excluded.value_max),
    value_count=value_count + excluded.value_count`);
  return db.transaction(() => {
    const window = nextWindow(db, 'metrics', cutoff);
    if (!window) return 0;
    const groups = new Map();
    for (const row of db.prepare('SELECT timestamp, metric, value FROM metrics WHERE timestamp >= ? AND timestamp < ?').iterate(...window)) {
      const key = `${bucketOf(row.timestamp)}\u0000${row.metric}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { bucket: bucketOf(row.timestamp), metric: row.metric, sum: 0, min: Infinity, max: -Infinity, count: 0 });
      if (row.value !== null) { g.sum += row.value; g.min = Math.min(g.min, row.value); g.max = Math.max(g.max, row.value); g.count++; }
    }
    for (const g of groups.values()) if (g.count) upsert.run(g.bucket, g.metric, g.sum / g.count, g.min, g.max, g.count);
    db.prepare('DELETE FROM metrics WHERE timestamp >= ? AND timestamp < ?').run(...window);
    return Math.max(groups.size, 1);
  })();
}

/** Roll up one window of `history` into history_5m and delete it. Returns buckets seen; 0 when nothing is due. */
function runHistoryBatch(db, cutoff) {
  const columns = [...INSTANT_FIELDS.flatMap(f => [`${f}_avg`, `${f}_min`, `${f}_max`, `${f}_count`, `${f}_last_value`, `${f}_last_timestamp`]),
    ...DAILY_FIELDS.map(f => `${f}_last`), 'battery_power_sum', 'battery_power_avg', 'battery_power_min', 'battery_power_max', 'battery_power_count', 'battery_power_last_value', 'battery_power_last_timestamp'];
  const updates = columns.map(c => `${c}=excluded.${c}`).join(', ');
  const historyUpsert = db.prepare(`INSERT INTO history_5m (bucket_start, ${columns.join(', ')}) VALUES (${Array(columns.length + 1).fill('?').join(', ')})
    ON CONFLICT(bucket_start) DO UPDATE SET ${updates}`);
  const sourceCols = ['timestamp', ...INSTANT_FIELDS, ...DAILY_FIELDS];
  return db.transaction(() => {
    const window = nextWindow(db, 'history', cutoff);
    if (!window) return 0;
    const buckets = new Map();
    for (const row of db.prepare(`SELECT ${sourceCols.join(', ')} FROM history WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp`).iterate(...window)) {
      const b = bucketOf(row.timestamp);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(row);
    }
    for (const [bucketStart, rows] of buckets) {
      const values = [bucketStart];
      for (const field of INSTANT_FIELDS) {
        const nums = rows.map(r => r[field]).filter(v => v !== null && Number.isFinite(v));
        const latest = [...rows].reverse().find(r => r[field] !== null && Number.isFinite(r[field]));
        values.push(nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
          nums.length ? Math.min(...nums) : null, nums.length ? Math.max(...nums) : null, nums.length,
          latest ? latest[field] : null, latest ? latest.timestamp : null);
      }
      const last = rows[rows.length - 1];
      for (const field of DAILY_FIELDS) values.push(last[field]);
      const paired = rows.filter(r => Number.isFinite(r.battery_charge) && Number.isFinite(r.battery_discharge))
        .map(r => ({ timestamp: r.timestamp, value: r.battery_charge - r.battery_discharge }));
      const netLast = paired[paired.length - 1];
      const netValues = paired.map(r => r.value);
      values.push(netValues.length ? netValues.reduce((a, b) => a + b, 0) : null,
        netValues.length ? netValues.reduce((a, b) => a + b, 0) / netValues.length : null,
        netValues.length ? Math.min(...netValues) : null, netValues.length ? Math.max(...netValues) : null,
        netValues.length, netLast ? netLast.value : null, netLast ? netLast.timestamp : null);
      historyUpsert.run(...values);
    }
    db.prepare('DELETE FROM history WHERE timestamp >= ? AND timestamp < ?').run(...window);
    return Math.max(buckets.size, 1);
  })();
}

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

/**
 * Roll up everything due, in windows, for at most `budgetMs` (the dashboard
 * keeps serving between windows). `more` is true when work was left for
 * the next run.
 */
async function runRollupOnce(options = {}) {
  const now = Number.isInteger(options.now) ? options.now : Math.floor(Date.now() / 1000);
  const cutoff = now - RETENTION_SECONDS;
  const budgetMs = options.budgetMs || BUDGET_MS;
  let release;
  try {
    release = await acquireLock('maintenance', { timeoutMs: options.lockTimeoutMs, allowPendingOsUpdate: true });
  } catch (error) {
    if (/timed out/i.test(error.message) || error.code === 'LOCK_BUSY') {
      logger.info('Retention rollup deferred: maintenance lock is busy');
      return { deferred: true, metricsGroups: 0, historyGroups: 0, more: true };
    }
    throw error;
  }
  try {
    const db = getDb();
    const started = Date.now();
    let metricsGroups = 0, historyGroups = 0, more = false;
    for (;;) {
      const m = runMetricsBatch(db, cutoff);
      const h = runHistoryBatch(db, cutoff);
      metricsGroups += m; historyGroups += h;
      if (!m && !h) break;
      if (Date.now() - started >= budgetMs) { more = true; break; }
      await yieldToEventLoop();
    }
    if (metricsGroups || historyGroups) {
      logger.info(`Retention rollup: ${metricsGroups} metric groups, ${historyGroups} history buckets${more ? ' (more to do)' : ''}`);
    }
    return { deferred: false, metricsGroups, historyGroups, more };
  } catch (error) {
    logger.error(`Retention rollup failed: ${error.message}`);
    throw error;
  } finally {
    release();
  }
}

/** Hourly; every CATCH_UP_MS while a backlog remains (the first run on an old database). */
class RetentionManager {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || ROLLUP_INTERVAL_MS;
    this.catchUpMs = options.catchUpMs || CATCH_UP_MS;
    this.firstRunMs = options.firstRunMs || FIRST_RUN_MS;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.budgetMs = options.budgetMs;
    this._timer = null;
    this._running = null;
    this._stopped = true;
  }

  _schedule(ms) {
    if (this._stopped) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick(), ms);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  async _tick() {
    if (this._running) return this._running;
    this._running = (async () => {
      let more = false;
      try { more = (await runRollupOnce({ lockTimeoutMs: this.lockTimeoutMs, budgetMs: this.budgetMs })).more; }
      catch (error) { logger.error(`Retention rollup tick failed: ${error.message}`); }
      finally { this._running = null; }
      this._schedule(more ? this.catchUpMs : this.intervalMs);
    })();
    return this._running;
  }

  start() {
    if (!this._stopped) return this;
    this._stopped = false;
    this._schedule(this.firstRunMs);
    return this;
  }

  /** Stops scheduling; resolves when a running batch has finished. */
  async stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    if (this._running) await this._running;
    return this;
  }
}

module.exports = { RetentionManager, ROLLUP_INTERVAL_MS, runRollupOnce, runMetricsBatch, runHistoryBatch };
