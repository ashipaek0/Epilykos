'use strict';

const { getDb } = require('./database');
const { acquireLock } = require('./maintenanceLock');
const { logger } = require('./logger');

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const BUCKET_SECONDS = 300;
const BATCH_SIZE = 1000;
const INSTANT_FIELDS = ['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc'];
const DAILY_FIELDS = ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export'];

function bucketOf(timestamp) {
  return Math.floor(timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
}

function runMetricsBatch(db, cutoff) {
  const cursor = { bucket: -Infinity, metric: '' };
  const upsert = db.prepare(`INSERT INTO metrics_5m (bucket_start, metric, value_avg, value_min, value_max, value_count)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bucket_start, metric) DO UPDATE SET
    value_avg=excluded.value_avg, value_min=excluded.value_min, value_max=excluded.value_max, value_count=excluded.value_count`);
  const transaction = db.transaction(() => {
    const groups = db.prepare(`SELECT DISTINCT CAST(timestamp / ? AS INTEGER) * ? AS bucket_start, metric
    FROM metrics WHERE timestamp < ? AND (CAST(timestamp / ? AS INTEGER) * ? + ?) <= ?
    AND (CAST(timestamp / ? AS INTEGER) * ? > ? OR (CAST(timestamp / ? AS INTEGER) * ? = ? AND metric > ?))
    ORDER BY bucket_start, metric LIMIT ?`).all(BUCKET_SECONDS, BUCKET_SECONDS, cutoff, BUCKET_SECONDS, BUCKET_SECONDS, BUCKET_SECONDS, cutoff,
      BUCKET_SECONDS, BUCKET_SECONDS, cursor.bucket, BUCKET_SECONDS, BUCKET_SECONDS, cursor.bucket, cursor.metric, BATCH_SIZE);
    if (!groups.length) return 0;
    const selected = [];
    const getRows = db.prepare(`SELECT timestamp, metric, value FROM metrics WHERE metric=? AND timestamp/ ? >= ? AND timestamp/ ? < ? AND timestamp < ? ORDER BY timestamp`);
    for (const group of groups) {
      const rows = getRows.all(group.metric, BUCKET_SECONDS, group.bucket_start / BUCKET_SECONDS, BUCKET_SECONDS, (group.bucket_start + BUCKET_SECONDS) / BUCKET_SECONDS, cutoff);
      let sum = 0, min = Infinity, max = -Infinity, count = 0;
      for (const row of rows) {
        selected.push(row);
        if (row.value !== null) { sum += row.value; min = Math.min(min, row.value); max = Math.max(max, row.value); count++; }
      }
      if (count) upsert.run(group.bucket_start, group.metric, sum / count, min, max, count);
      cursor.bucket = group.bucket_start;
      cursor.metric = group.metric;
    }
    if (selected.length) {
    const del = db.prepare('DELETE FROM metrics WHERE timestamp=? AND metric=?');
    for (const row of selected) del.run(row.timestamp, row.metric);
    }
    return groups.length;
  });
  return transaction();
}

function runHistoryBatch(db, cutoff) {
  let cursor = -Infinity;
  const columns = [...INSTANT_FIELDS.flatMap(f => [`${f}_avg`, `${f}_min`, `${f}_max`, `${f}_count`, `${f}_last_value`, `${f}_last_timestamp`]),
    ...DAILY_FIELDS.map(f => `${f}_last`), 'battery_power_sum', 'battery_power_avg', 'battery_power_min', 'battery_power_max', 'battery_power_count', 'battery_power_last_value', 'battery_power_last_timestamp'];
  const updates = columns.map(c => `${c}=excluded.${c}`).join(', ');
  const historyUpsert = db.prepare(`INSERT INTO history_5m (bucket_start, ${columns.join(', ')}) VALUES (${Array(columns.length + 1).fill('?').join(', ')})
    ON CONFLICT(bucket_start) DO UPDATE SET ${updates}`);
  const transaction = db.transaction(() => {
    const groups = db.prepare(`SELECT DISTINCT CAST(timestamp / ? AS INTEGER) * ? AS bucket_start FROM history
      WHERE timestamp < ? AND (CAST(timestamp / ? AS INTEGER) * ? + ?) <= ? AND CAST(timestamp / ? AS INTEGER) * ? > ?
      ORDER BY bucket_start LIMIT ?`).all(BUCKET_SECONDS, BUCKET_SECONDS, cutoff, BUCKET_SECONDS, BUCKET_SECONDS, BUCKET_SECONDS, cutoff,
        BUCKET_SECONDS, BUCKET_SECONDS, cursor, BATCH_SIZE);
    if (!groups.length) return 0;
    const sourceCols = ['timestamp', ...INSTANT_FIELDS, ...DAILY_FIELDS];
    const selected = [];
    const getRows = db.prepare(`SELECT ${sourceCols.join(', ')} FROM history WHERE timestamp >= ? AND timestamp < ? AND timestamp < ? ORDER BY timestamp`);
    for (const { bucket_start } of groups) {
      const rows = getRows.all(bucket_start, bucket_start + BUCKET_SECONDS, cutoff);
      if (!rows.length) continue;
      selected.push(...rows.map(r => r.timestamp));
      const values = [bucket_start];
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
      cursor = bucket_start;
    }
    const del = db.prepare('DELETE FROM history WHERE timestamp=?');
    for (const timestamp of new Set(selected)) del.run(timestamp);
    return groups.length;
  });
  return transaction();
}

async function runRollupOnce(options = {}) {
  const now = Number.isInteger(options.now) ? options.now : Math.floor(Date.now() / 1000);
  const cutoff = now - RETENTION_SECONDS;
  let release;
  try {
    release = await acquireLock('maintenance', { timeoutMs: options.lockTimeoutMs });
  } catch (error) {
    if (/timed out/i.test(error.message)) {
      logger.info('Retention rollup deferred: maintenance lock is busy');
      return { deferred: true, metricsGroups: 0, historyGroups: 0 };
    }
    throw error;
  }
  try {
    logger.info('Retention rollup started');
    const db = getDb();
    const metricsGroups = runMetricsBatch(db, cutoff);
    const historyGroups = runHistoryBatch(db, cutoff);
    const result = { deferred: false, metricsGroups, historyGroups };
    logger.info(`Retention rollup completed: ${metricsGroups} metric groups, ${historyGroups} history buckets`);
    return result;
  } catch (error) {
    logger.error(`Retention rollup failed: ${error.message}`);
    throw error;
  } finally {
    release();
  }
}

class RetentionManager {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || ROLLUP_INTERVAL_MS;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this._timer = null;
    this._isRunning = false;
  }

  async _tick() {
    if (this._isRunning) return;
    this._isRunning = true;
    try { await runRollupOnce({ lockTimeoutMs: this.lockTimeoutMs }); }
    catch (error) { logger.error(`Retention rollup tick failed: ${error.message}`); }
    finally { this._isRunning = false; }
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => { this._tick(); }, this.intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    this._tick();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }
}

module.exports = { RetentionManager, ROLLUP_INTERVAL_MS, runRollupOnce, runHistoryBatch };
