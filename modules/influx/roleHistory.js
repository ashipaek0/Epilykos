'use strict';
/**
 * After an import, fill the role history (the `history` and `history_5m` tables: solar, load, battery, grid and their
 * daily counters) for the imported time, from the imported readings of the role metrics (config role_metrics). Reports,
 * savings, the energy charts and the daily totals read these tables, not the metrics, so without this an imported day
 * would show in a metric's chart but nowhere else.
 *
 *   older than the raw retention  → history_5m, one row per 5-minute bucket. Its counts are at least 2, which every
 *                                   reader takes as "a rolled-up 5 minutes" (a count of 1 is a single raw sample, which
 *                                   counts for at most two minutes of energy)
 *   within it                     → history, five rows a minute apart per bucket (the way the poller would have written
 *                                   them), so the energy of each 5 minutes counts in full; the retention job rolls
 *                                   them up later like any other
 *
 * The dashboard's own history always wins: a bucket that already has a row in either table is left as it is.
 *
 * @module influx/roleHistory
 */

const { BUCKET_SECONDS, RETENTION_SECONDS } = require('../timeseriesReader');
const { ROLE_TO_COL } = require('../history');

const DAY = 86400;
const INSTANT = ['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc', 'generator'];
const DAILY = ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export', 'daily_generator'];
const bucketOf = t => Math.floor(t / BUCKET_SECONDS) * BUCKET_SECONDS;

/** column → metric name, from role_metrics (only the roles the history table has). */
function roleColumns(roleMetrics) {
  const out = {};
  for (const [role, metric] of Object.entries(roleMetrics || {})) {
    const col = ROLE_TO_COL[role];
    if (col && typeof metric === 'string' && metric.trim()) out[col] = metric.trim();
  }
  return out;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{from: number, to: number, roleMetrics: object, onlyMetrics?: string[], now?: number}} options seconds;
 *   onlyMetrics limits the work to buckets where one of these metrics has a reading (the ones just imported)
 * @returns {{rolled: number, raw: number, skipped: number}} buckets written to history_5m, to history, and left alone
 */
function buildRoleHistory(db, { from, to, roleMetrics, onlyMetrics, now = Math.floor(Date.now() / 1000) }) {
  const cols = roleColumns(roleMetrics);
  const only = onlyMetrics ? new Set(onlyMetrics) : null;
  const metricsUsed = [...new Set(Object.values(cols))].filter(m => !only || only.has(m));
  const result = { rolled: 0, raw: 0, skipped: 0 };
  if (!metricsUsed.length || !(to > from)) return result;
  const cutoff = now - RETENTION_SECONDS;
  const allMetrics = [...new Set(Object.values(cols))];
  const placeholders = allMetrics.map(() => '?').join(', ');
  const h5 = tableColumns(db, 'history_5m');
  const h = tableColumns(db, 'history');

  const has5m = db.prepare('SELECT 1 FROM history_5m WHERE bucket_start = ?');
  const hasRaw = db.prepare('SELECT 1 FROM history WHERE timestamp >= ? AND timestamp < ? LIMIT 1');
  const taken = b => !!(has5m.get(b) || hasRaw.get(b, b + BUCKET_SECONDS));

  // ── history_5m ──
  const cols5 = ['bucket_start'];
  for (const f of INSTANT) for (const suffix of ['avg', 'min', 'max', 'count', 'last_value', 'last_timestamp']) if (h5.has(`${f}_${suffix}`)) cols5.push(`${f}_${suffix}`);
  for (const f of DAILY) if (h5.has(`${f}_last`)) cols5.push(`${f}_last`);
  const battery = ['battery_power_sum', 'battery_power_avg', 'battery_power_min', 'battery_power_max', 'battery_power_count', 'battery_power_last_value', 'battery_power_last_timestamp'];
  const hasBattery = battery.every(c => h5.has(c));
  if (hasBattery) cols5.push(...battery);
  const insert5 = db.prepare(`INSERT INTO history_5m (${cols5.join(', ')}) VALUES (${cols5.map(() => '?').join(', ')}) ON CONFLICT(bucket_start) DO NOTHING`);
  const read5 = db.prepare(`SELECT bucket_start AS b, metric, value_avg AS avg, value_min AS min, value_max AS max, value_count AS count
    FROM metrics_5m WHERE metric IN (${placeholders}) AND bucket_start >= ? AND bucket_start < ?`);

  // ── history (raw) ──
  const rawCols = ['timestamp', ...INSTANT.filter(f => h.has(f)), ...DAILY.filter(f => h.has(f))];
  const insertRaw = db.prepare(`INSERT OR IGNORE INTO history (${rawCols.join(', ')}) VALUES (${rawCols.map(() => '?').join(', ')})`);
  const readRaw = db.prepare(`SELECT timestamp AS t, metric, value FROM metrics WHERE metric IN (${placeholders}) AND value IS NOT NULL AND timestamp >= ? AND timestamp < ?`);

  const colsOf = metric => Object.keys(cols).filter(c => cols[c] === metric);

  for (let start = bucketOf(from); start < to; start += DAY) {
    const end = Math.min(start + DAY, to);
    db.transaction(() => {
      // Older than the raw retention: one history_5m row per bucket.
      if (start < cutoff) {
        const buckets = new Map();   // b → { col → {avg,min,max,count}, touched }
        for (const r of read5.all(...allMetrics, start, Math.min(end, cutoff))) {
          if (!buckets.has(r.b)) buckets.set(r.b, { touched: false });
          const row = buckets.get(r.b);
          if (!only || only.has(r.metric)) row.touched = true;
          for (const c of colsOf(r.metric)) row[c] = r;
        }
        for (const [b, row] of buckets) {
          if (!row.touched) continue;
          if (taken(b)) { result.skipped++; continue; }
          const values = [b];
          for (const f of INSTANT) {
            const v = row[f];
            const n = v ? Math.max(2, v.count) : 0;   // ≥ 2: a rolled-up 5 minutes, not one sample
            const pick = { avg: v ? v.avg : null, min: v ? v.min : null, max: v ? v.max : null, count: n, last_value: v ? v.avg : null, last_timestamp: v ? b : null };
            for (const suffix of ['avg', 'min', 'max', 'count', 'last_value', 'last_timestamp']) if (h5.has(`${f}_${suffix}`)) values.push(pick[suffix]);
          }
          for (const f of DAILY) if (h5.has(`${f}_last`)) values.push(row[f] ? row[f].max : null);   // a counter's latest is its highest
          if (hasBattery) {
            const c = row.battery_charge, d = row.battery_discharge;
            if (c && d) {
              const net = c.avg - d.avg, n = Math.max(2, Math.min(c.count, d.count));
              values.push(net * n, net, net, net, n, net, b);
            } else values.push(null, null, null, null, 0, null, null);
          }
          insert5.run(...values);
          result.rolled++;
        }
      }
      // Within the raw retention: five raw rows a minute apart per bucket.
      if (end > cutoff) {
        const buckets = new Map();
        for (const r of readRaw.all(...allMetrics, Math.max(start, cutoff), end)) {
          const b = bucketOf(r.t);
          if (!buckets.has(b)) buckets.set(b, { touched: false });
          const row = buckets.get(b);
          if (!only || only.has(r.metric)) row.touched = true;
          for (const c of colsOf(r.metric)) (row[c] = row[c] || []).push(r.value);
        }
        for (const [b, row] of buckets) {
          if (!row.touched || b + BUCKET_SECONDS > now) continue;
          if (taken(b)) { result.skipped++; continue; }
          const values = rawCols.slice(1).map(c => {
            const list = row[c];
            if (!list || !list.length) return null;
            return DAILY.includes(c) ? Math.max(...list) : list.reduce((a, x) => a + x, 0) / list.length;
          });
          for (let t = b; t < b + BUCKET_SECONDS; t += 60) insertRaw.run(t, ...values);
          result.raw++;
        }
      }
    })();
  }
  return result;
}

module.exports = { buildRoleHistory, roleColumns };
