'use strict';

const { SQL_LOCAL_DAY } = require('./localTime');

const BUCKET_SECONDS = 300;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const INSTANT_FIELDS = new Set(['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc']);
const DAILY_FIELDS = new Set(['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export']);
const cutoffNow = () => Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
const toOperator = inclusive => inclusive ? '<=' : '<';

function readMetricSeries(db, { metric, from, to, toInclusive = false }) {
  const cutoff = cutoffNow();
  const op = toOperator(toInclusive);
  const aggregates = db.prepare(`SELECT bucket_start AS timestamp, value_avg AS value, value_count AS count
    FROM metrics_5m WHERE metric = ? AND bucket_start + ? > ? AND bucket_start ${op} ?`).all(metric, BUCKET_SECONDS, from, Math.min(to, cutoff));
  const rolledBuckets = new Set(aggregates.map(row => row.timestamp));
  const raw = db.prepare(`SELECT timestamp, value, 1 AS count FROM metrics WHERE metric = ?
    AND timestamp >= ? AND timestamp ${op} ?`).all(metric, Math.max(from, cutoff), to)
    .filter(row => !rolledBuckets.has(Math.floor(row.timestamp / BUCKET_SECONDS) * BUCKET_SECONDS));
  return [...aggregates, ...raw].sort((a, b) => a.timestamp - b.timestamp || (a.count === 1 ? -1 : 1));
}

function readHistorySeries(db, { from, to, toInclusive = false, fields }) {
  const requested = [...new Set(fields || [])];
  for (const field of requested) {
    if (!INSTANT_FIELDS.has(field) && !DAILY_FIELDS.has(field)) throw new Error(`Unsupported history field: ${field}`);
  }
  const cutoff = cutoffNow();
  const op = toOperator(toInclusive);
  const rows = new Map();
  const instantaneous = requested.filter(field => INSTANT_FIELDS.has(field));
  const daily = requested.filter(field => DAILY_FIELDS.has(field));
  if (requested.length) {
    const rawCols = ['timestamp', ...requested].join(', ');
    const raw = db.prepare(`SELECT ${rawCols} FROM history WHERE timestamp >= ? AND timestamp ${op} ?`).all(Math.max(from, cutoff), to);
    for (const row of raw) {
      const output = { timestamp: row.timestamp };
      for (const field of requested) { output[field] = row[field]; if (INSTANT_FIELDS.has(field)) output[`${field}_count`] = 1; }
      rows.set(row.timestamp, { output, aggregate: false });
    }
    const aggCols = ['bucket_start AS timestamp', ...instantaneous.flatMap(field => [`${field}_avg AS ${field}`, `${field}_count AS ${field}_count`]), ...daily.map(field => `${field}_last AS ${field}`)].join(', ');
    const aggregates = db.prepare(`SELECT ${aggCols} FROM history_5m WHERE bucket_start + ? > ? AND bucket_start ${op} ?`).all(BUCKET_SECONDS, from, Math.min(to, cutoff));
    for (const row of aggregates) {
      const output = { timestamp: row.timestamp };
      for (const field of requested) { output[field] = row[field]; if (INSTANT_FIELDS.has(field)) output[`${field}_count`] = row[`${field}_count`]; }
      rows.set(row.timestamp, { output, aggregate: true });
    }
    const rolled = new Set(aggregates.map(row => row.timestamp));
    for (const [timestamp, item] of rows) {
      if (!item.aggregate && rolled.has(Math.floor(timestamp / BUCKET_SECONDS) * BUCKET_SECONDS)) rows.delete(timestamp);
    }
  }
  return [...rows.values()].map(item => item.output).sort((a, b) => a.timestamp - b.timestamp);
}

function readDailySnapshots(db, { from, to, toInclusive = false, fields }) {
  const requested = [...new Set(fields || [])];
  for (const field of requested) if (!DAILY_FIELDS.has(field)) throw new Error(`Unsupported daily field: ${field}`);
  if (!requested.length) return [];
  const op = toOperator(toInclusive);
  const rawBound = from !== undefined && from !== null ? ` AND timestamp >= ${Number(from)}` : '';
  const rawUpper = to !== undefined && to !== null ? ` AND timestamp ${op} ${Number(to)}` : '';
  const aggBound = from !== undefined && from !== null ? ` AND bucket_start + ${BUCKET_SECONDS} > ${Number(from)}` : '';
  const aggUpper = to !== undefined && to !== null ? ` AND bucket_start ${op} ${Number(to)}` : '';
  const selects = requested.map(field => `MAX(${field}) AS ${field}`).join(', ');
  const aggSelects = requested.map(field => `MAX(${field}_last) AS ${field}`).join(', ');
  const rows = db.prepare(`SELECT day, ${requested.map(field => `MAX(${field}) AS ${field}`).join(', ')} FROM (
    SELECT ${SQL_LOCAL_DAY} AS day, ${requested.join(', ')} FROM history WHERE 1=1${rawBound}${rawUpper}
    UNION ALL
    SELECT ${SQL_LOCAL_DAY.replaceAll('timestamp', 'bucket_start')} AS day, ${requested.map(field => `${field}_last AS ${field}`).join(', ')} FROM history_5m WHERE 1=1${aggBound}${aggUpper}
  ) GROUP BY day ORDER BY day ASC`).all();
  return rows.map(row => {
    const output = { day: row.day };
    for (const field of requested) output[field] = row[field];
    return output;
  });
}

module.exports = { readMetricSeries, readHistorySeries, readDailySnapshots };
