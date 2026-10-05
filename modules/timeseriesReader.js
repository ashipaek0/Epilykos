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

const POWER_STATS_FIELDS = Object.freeze({
  pv_power: 'solar', grid_power: 'grid_import', load_power: 'consumption',
  battery_charge_power: 'battery_charge', battery_discharge_power: 'battery_discharge',
  battery_power: 'battery_power', grid_export_power: 'grid_export'
});

function readPowerStats(db, { from, to, fields }) {
  const requested = [...new Set(fields)];
  const supported = requested.filter(field => Object.hasOwn(POWER_STATS_FIELDS, field));
  const cutoff = cutoffNow();
  const rawColumns = [...new Set(supported.flatMap(field => field === 'battery_power' ? ['battery_charge', 'battery_discharge'] : [POWER_STATS_FIELDS[field]]))];
  let rollups = [];
  if (supported.length && from < cutoff) {
    const cols = supported.flatMap(f => { const s = POWER_STATS_FIELDS[f]; return f === 'battery_power'
      ? ['battery_power_sum AS battery_power_sum', 'battery_power_avg AS battery_power_avg', 'battery_power_min AS battery_power_min', 'battery_power_max AS battery_power_max', 'battery_power_count AS battery_power_count', 'battery_power_last_value AS battery_power_last_value', 'battery_power_last_timestamp AS battery_power_last_timestamp']
      : [`${s}_avg AS ${f}_avg`, `${s}_min AS ${f}_min`, `${s}_max AS ${f}_max`, `${s}_count AS ${f}_count`, `${s}_last_value AS ${f}_last_value`, `${s}_last_timestamp AS ${f}_last_timestamp`]; });
    rollups = db.prepare(`SELECT bucket_start, ${cols.join(', ')} FROM history_5m WHERE bucket_start < ? AND bucket_start + ? > ?`).all(Math.min(to, cutoff), BUCKET_SECONDS, from);
  }
  const rolledBuckets = new Set(rollups.map(row => row.bucket_start));
  const raw = supported.length && to > cutoff
    ? db.prepare(`SELECT timestamp, ${rawColumns.join(', ')} FROM history WHERE timestamp >= ? AND timestamp < ?`).all(Math.max(from, cutoff), to)
    : [];
  const stats = Object.fromEntries(requested.map(field => [field, { sum: 0, sumOverflow: false, count: 0, min: Infinity, max: -Infinity, last: null, lastUnknownAt: null, unavailable: new Set(), warnings: [] }]));
  for (const field of supported) {
    const storage = POWER_STATS_FIELDS[field], state = stats[field];
    for (const row of raw) {
      if (rolledBuckets.has(Math.floor(row.timestamp / BUCKET_SECONDS) * BUCKET_SECONDS)) continue;
      const value = field === 'battery_power' ? (Number.isFinite(row.battery_charge) && Number.isFinite(row.battery_discharge) ? row.battery_charge - row.battery_discharge : null) : row[storage];
      if (Number.isSafeInteger(row.timestamp) && row.timestamp >= from && row.timestamp < to && Number.isFinite(value)) {
        const nextSum = state.sum + value;
        if (!Number.isFinite(nextSum)) state.sumOverflow = true;
        else if (!state.sumOverflow) state.sum = nextSum;
        state.count++; state.min = Math.min(state.min, value); state.max = Math.max(state.max, value);
        if (!state.last || row.timestamp > state.last.timestamp) state.last = { timestamp: row.timestamp, value };
      }
    }
  }
  for (const row of rollups) {
    for (const field of supported) {
      const state = stats[field], count = row[`${field}_count`], avg = row[`${field}_avg`];
      if (!Number.isSafeInteger(row.bucket_start)) continue;
      const complete = row.bucket_start >= from && row.bucket_start + BUCKET_SECONDS <= to;
      if (!complete) { state.unavailable.add('mean'); state.unavailable.add('min'); state.unavailable.add('max'); state.unavailable.add('last'); state.warnings.push({ code: 'partial_edge_bucket', stats: ['mean', 'min', 'max', 'last'] }); continue; }
      if (Number.isSafeInteger(count) && count > 0 && Number.isFinite(avg) && Number.isFinite(row[`${field}_min`]) && Number.isFinite(row[`${field}_max`])) {
        const exactSum = field === 'battery_power' && Number.isFinite(row.battery_power_sum) ? row.battery_power_sum : avg * count;
        const nextSum = state.sum + exactSum;
        if (!Number.isFinite(exactSum) || !Number.isFinite(nextSum)) state.sumOverflow = true;
        else if (!state.sumOverflow) state.sum = nextSum;
        state.count += count; state.min = Math.min(state.min, row[`${field}_min`]); state.max = Math.max(state.max, row[`${field}_max`]);
      } else if (field === 'battery_power') {
        state.unavailable.add('mean'); state.unavailable.add('min'); state.unavailable.add('max');
        state.warnings.push({ code: 'legacy_rollup_lacks_net_aggregates', stats: ['mean', 'min', 'max'] });
      }
      const ts = row[`${field}_last_timestamp`], value = row[`${field}_last_value`];
      if (Number.isSafeInteger(ts) && Number.isFinite(value) && ts >= from && ts < to) {
        if (!state.last || ts > state.last.timestamp) state.last = { timestamp: ts, value };
      } else {
        state.lastUnknownAt = Math.max(state.lastUnknownAt ?? -Infinity, row.bucket_start + BUCKET_SECONDS - 1);
      }
    }
  }
  const fieldsOut = Object.create(null);
  for (const field of requested) {
    const state = stats[field], isSupported = supported.includes(field);
    if (!isSupported) {
      fieldsOut[field] = emptyPowerStat('unsupported', [{ code: 'unsupported_series', stats: ['mean', 'min', 'max', 'last'] }]); continue;
    }
    const warnings = [...state.warnings];
    if (state.sumOverflow) warnings.push({ code: 'numeric_overflow', stats: ['mean'] });
    const lastUnavailable = state.lastUnknownAt !== null && (!state.last || state.lastUnknownAt > state.last.timestamp);
    if (lastUnavailable) warnings.push({ code: 'legacy_rollup_lacks_last', stats: ['last'] });
    const availableStats = [];
    for (const stat of ['mean', 'min', 'max', 'last']) {
      const lastUnavailable = state.lastUnknownAt !== null && (!state.last || state.lastUnknownAt > state.last.timestamp);
      const unavailable = state.unavailable.has(stat) || (stat === 'last' && lastUnavailable);
      if (unavailable) continue;
      if (stat !== 'last' && state.count === 0 || stat === 'last' && !state.last) continue;
      availableStats.push(stat);
    }
    const legacyStats = availableStats.filter(s => !state.unavailable.has(s));
    if (state.count > 0 && legacyStats.length) warnings.push({ code: 'legacy_missing_zero_possible', stats: legacyStats });
    const valueFor = stat => {
      const lastUnavailable = state.lastUnknownAt !== null && (!state.last || state.lastUnknownAt > state.last.timestamp);
      if (state.unavailable.has(stat) || stat === 'last' && lastUnavailable || stat === 'mean' && state.sumOverflow) return null;
      if (stat === 'mean') return state.count ? state.sum / state.count : null;
      if (stat === 'min') return state.count ? state.min : null;
      if (stat === 'max') return state.count ? state.max : null;
      return state.last;
    };
    const entry = { status: 'no_data', unit: 'W', sum: null, count: 0, mean: null, min: null, max: null, last: null, fidelity: {} };
    const values = { mean: valueFor('mean'), min: valueFor('min'), max: valueFor('max'), last: valueFor('last') };
    const nonNull = Object.values(values).some(v => v !== null);
    entry.count = state.count; entry.sum = state.count && !state.sumOverflow ? state.sum : null;
    entry.mean = values.mean; entry.min = values.min; entry.max = values.max; entry.last = values.last;
    entry.status = !nonNull ? (state.count ? 'unavailable' : 'no_data') : Object.values(values).some(v => v === null) || state.sumOverflow ? 'partial' : 'ok';
    for (const stat of ['mean', 'min', 'max', 'last']) entry.fidelity[stat] = values[stat] === null ? 'unavailable' : 'stored_observations';
    if (!state.count) warnings.push({ code: 'no_valid_observations', stats: ['mean', 'min', 'max', 'last'] });
    entry.fidelity.warnings = warnings;
    fieldsOut[field] = entry;
  }
  return { schemaVersion: 1, range: { from, to, boundary: '[from,to)' }, fields: fieldsOut };
}

function emptyPowerStat(status, warnings) {
  return { status, unit: 'W', sum: null, count: 0, mean: null, min: null, max: null, last: null, fidelity: { mean: 'unavailable', min: 'unavailable', max: 'unavailable', last: 'unavailable', warnings } };
}

module.exports = { readMetricSeries, readHistorySeries, readDailySnapshots, readPowerStats };
