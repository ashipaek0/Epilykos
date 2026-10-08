'use strict';

const { localDateString } = require('./localTime');

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
    FROM metrics_5m WHERE metric = ? AND bucket_start > ? AND bucket_start ${op} ?`).all(metric, from - BUCKET_SECONDS, Math.min(to, cutoff));
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
    const aggregates = db.prepare(`SELECT ${aggCols} FROM history_5m WHERE bucket_start > ? AND bucket_start ${op} ?`).all(from - BUCKET_SECONDS, Math.min(to, cutoff));
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

// Every time zone in use is a whole number of 15 minutes from UTC (and DST
// moves by 30 or 60 minutes), so a 15-minute bucket never straddles a local
// midnight. Grouping by bucket in SQL is cheap integer arithmetic; SQLite's
// 'localtime' per row (the old way) took seconds over a month of readings.
const DAY_PART_SECONDS = 900;

// All-time reads (no from/to) with `cached: true` keep the finished days for a
// while and only re-read today: the dashboard asks for all-time totals on every
// load, and past days don't change. Refreshed every few minutes and when the
// local day changes, so an import or late rollup still shows up.
const ALL_TIME_CACHE_MS = 10 * 60 * 1000;
const allTimeCache = new WeakMap();   // db -> Map(fields key -> { today, at, past })

function readDailySnapshots(db, { from, to, toInclusive = false, fields, cached = false }) {
  if (cached && (from === undefined || from === null) && (to === undefined || to === null)) return readAllTimeCached(db, fields);
  const requested = [...new Set(fields || [])];
  for (const field of requested) if (!DAILY_FIELDS.has(field)) throw new Error(`Unsupported daily field: ${field}`);
  if (!requested.length) return [];
  const op = toOperator(toInclusive);
  const hasFrom = from !== undefined && from !== null, hasTo = to !== undefined && to !== null;
  const rawWhere = [hasFrom ? 'timestamp >= @from' : '', hasTo ? `timestamp ${op} @to` : ''].filter(Boolean).join(' AND ') || '1=1';
  const aggWhere = [hasFrom ? 'bucket_start > @fromBucket' : '', hasTo ? `bucket_start ${op} @to` : ''].filter(Boolean).join(' AND ') || '1=1';
  const params = {};
  if (hasFrom) { params.from = Number(from); params.fromBucket = Number(from) - BUCKET_SECONDS; }
  if (hasTo) params.to = Number(to);
  const parts = db.prepare(`SELECT part, ${requested.map(field => `MAX(${field}) AS ${field}`).join(', ')} FROM (
    SELECT timestamp / ${DAY_PART_SECONDS} AS part, ${requested.join(', ')} FROM history WHERE ${rawWhere}
    UNION ALL
    SELECT bucket_start / ${DAY_PART_SECONDS} AS part, ${requested.map(field => `${field}_last AS ${field}`).join(', ')} FROM history_5m WHERE ${aggWhere}
  ) GROUP BY part ORDER BY part ASC`).all(params);
  const days = new Map();
  for (const row of parts) {
    const day = localDateString(new Date(row.part * DAY_PART_SECONDS * 1000));
    let out = days.get(day);
    if (!out) { out = { day }; for (const field of requested) out[field] = null; days.set(day, out); }
    for (const field of requested) {
      const v = row[field];
      if (v !== null && v !== undefined && (out[field] === null || v > out[field])) out[field] = v;
    }
  }
  return [...days.values()];
}

/** Forget cached finished days (after writing into past days directly). */
function clearDailySnapshotCache(db) { if (db) allTimeCache.delete(db); }

function readAllTimeCached(db, fields) {
  const key = [...new Set(fields || [])].sort().join(',');
  const now = new Date();
  const today = localDateString(now);
  const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  let byFields = allTimeCache.get(db);
  if (!byFields) { byFields = new Map(); allTimeCache.set(db, byFields); }
  let entry = byFields.get(key);
  if (!entry || entry.today !== today || Date.now() - entry.at > ALL_TIME_CACHE_MS) {
    const all = readDailySnapshots(db, { fields });
    entry = { today, at: Date.now(), past: all.filter(row => row.day < today) };
    byFields.set(key, entry);
  }
  const current = readDailySnapshots(db, { from: todayStart, fields }).filter(row => row.day >= today);
  return entry.past.concat(current);
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
    rollups = db.prepare(`SELECT bucket_start, ${cols.join(', ')} FROM history_5m WHERE bucket_start < ? AND bucket_start > ?`).all(Math.min(to, cutoff), from - BUCKET_SECONDS);
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

module.exports = { readMetricSeries, readHistorySeries, readDailySnapshots, readPowerStats, clearDailySnapshotCache };
