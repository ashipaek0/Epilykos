/**
 * Energy Metrics & Telemetry Routes
 *
 * Provides REST API endpoints for current power state, time-series history,
 * daily/monthly energy rollups, grid timeline, solar forecasts, and dashboard configurations.
 *
 * @module routes/metrics
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, getDb } = require('../modules/database');
const { computeTodaySolar, getSolarForecast } = require('../modules/solar');
const { getGridHours, getGridTimeline, getCurrentGridStatus } = require('../modules/grid');
const { getSavings } = require('../modules/savings');
const metricSanity = require('../modules/metricSanity');
const { getDashboardConfig } = require('../modules/dashboard-config');
const { localDateString } = require('../modules/localTime');
const { readHistorySeries, readDailySnapshots, readPowerStats } = require('../modules/timeseriesReader');

const { getCurrentMetrics } = require('../modules/metrics');

const router = express.Router();

const POWER_HISTORY_BUCKET_SECONDS = 600;
const POWER_HISTORY_FIELDS = ['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc'];

/**
 * Re-bucket readHistorySeries() instant rows (5-min aggregate avgs + raw
 * points, each carrying a `<field>_count`) into POWER_HISTORY_BUCKET_SECONDS
 * (10-min) buckets using count-weighted averaging — a naive mean-of-means
 * would under-weight a 5-min aggregate bucket (count=60) against a lone raw
 * point (count=1) that happens to land in the same 10-min window.
 */
function bucketPowerHistory(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const timestamp = Math.floor(row.timestamp / POWER_HISTORY_BUCKET_SECONDS) * POWER_HISTORY_BUCKET_SECONDS;
    let bucket = buckets.get(timestamp);
    if (!bucket) { bucket = { timestamp, sums: {}, counts: {} }; buckets.set(timestamp, bucket); }
    for (const field of POWER_HISTORY_FIELDS) {
      const value = row[field];
      if (value == null) continue;
      const count = row[`${field}_count`] || 1;
      bucket.sums[field] = (bucket.sums[field] || 0) + value * count;
      bucket.counts[field] = (bucket.counts[field] || 0) + count;
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(bucket => {
      const out = { timestamp: bucket.timestamp };
      for (const field of POWER_HISTORY_FIELDS) out[field] = bucket.counts[field] ? bucket.sums[field] / bucket.counts[field] : null;
      return out;
    });
}

/**
 * Latest history row projected to the dashboard's "current" shape (kW / kWh,
 * savings). Returns null when no history row exists yet.
 */
function buildCurrentData(db) {
  const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
  if (!latest) return null;
  const dailySolarKwh = computeTodaySolar();
  const rate = parseFloat(getConfig('savings_rate')) || 0.30;
  const curr = getConfig('savings_currency') || '€';
  const allTimeSolar = { total: readDailySnapshots(db, { fields: ["daily_solar"] }).reduce((sum, row) => sum + (row.daily_solar || 0), 0) };
  const allTimeSavings = (allTimeSolar?.total || 0) * rate;
  return {
    consumption_kw: latest.consumption / 1000,
    solar_kw: latest.solar / 1000,
    battery_charge_kw: latest.battery_charge / 1000,
    battery_discharge_kw: latest.battery_discharge / 1000,
    battery_power_kw: (latest.battery_charge - latest.battery_discharge) / 1000,
    grid_import_kw: latest.grid_import / 1000,
    grid_export_kw: latest.grid_export / 1000,
    battery_soc: latest.battery_soc,
    daily_consumption_kwh: latest.daily_consumption,
    daily_solar_kwh: dailySolarKwh,
    daily_battery_charge_kwh: latest.daily_battery_charge,
    daily_battery_discharge_kwh: latest.daily_battery_discharge,
    daily_grid_import_kwh: latest.daily_grid_import,
    daily_grid_export_kwh: latest.daily_grid_export,
    savings_currency: curr,
    savings_rate: rate,
    today_savings: dailySolarKwh * rate,
    all_time_savings: allTimeSavings,
    timestamp: latest.timestamp * 1000
  };
}

async function buildDashboardState() {
  const db = getDb();
  const start = Date.now();
  const currentData = buildCurrentData(db);

  const gridStatus = await getCurrentGridStatus();
  const now = Math.floor(Date.now() / 1000);
  const powerHistorySince = now - 86400;
  const barSince = now - (7 * 86400);

  const [metrics, savings, historyRows, barRows] = await Promise.all([
    getCurrentMetrics(),
    getSavings(),
    Promise.resolve(bucketPowerHistory(readHistorySeries(db, { from: powerHistorySince, to: now, toInclusive: true, fields: POWER_HISTORY_FIELDS }))),
    Promise.resolve(readDailySnapshots(db, { from: barSince, to: now, toInclusive: true, fields: ['daily_solar', 'daily_consumption', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export'] }).map(r => ({ day: r.day, solar_kwh: r.daily_solar, consumption_kwh: r.daily_consumption, battery_charge_kwh: r.daily_battery_charge, battery_discharge_kwh: r.daily_battery_discharge, grid_import_kwh: r.daily_grid_import, grid_export_kwh: r.daily_grid_export })))
  ]);

  const [gridHoursDay, gridHoursWeek, gridHoursMonth, gridHoursYear, gridTimeline] = gridStatus.configured
    ? await Promise.all([
        getGridHours('day'), getGridHours('week'), getGridHours('month'), getGridHours('year'),
        getGridTimeline('24h')
      ])
    : [0, 0, 0, 0, { configured: false, available: false, segments: [], windowStart: 0, windowEnd: 0 }];

  const gridHours = {
    day: gridHoursDay,
    week: gridHoursWeek,
    month: gridHoursMonth,
    year: gridHoursYear,
    configured: gridStatus.configured,
    available: gridStatus.available
  };

  const powerHistory = historyRows.map(r => ({
    timestamp: r.timestamp * 1000,
    consumption_kw: r.consumption / 1000,
    solar_kw: r.solar / 1000,
    battery_charge_kw: r.battery_charge / 1000,
    battery_discharge_kw: r.battery_discharge / 1000,
    battery_power_kw: (r.battery_charge - r.battery_discharge) / 1000,
    grid_import_kw: r.grid_import / 1000,
    grid_export_kw: r.grid_export / 1000
  }));

  const dailyEnergyBar = barRows.map(r => ({
    day: r.day,
    solar_kwh: r.solar_kwh,
    consumption_kwh: r.consumption_kwh,
    battery_charge_kwh: r.battery_charge_kwh,
    battery_discharge_kwh: r.battery_discharge_kwh,
    grid_import_kwh: r.grid_import_kwh,
    grid_export_kwh: r.grid_export_kwh
  }));

  const elapsed = Date.now() - start;
  logger.debug(`buildDashboardState took ${elapsed}ms`);

  return {
    current: currentData,
    metrics,
    savings,
    gridStatus,
    gridHours,
    gridTimeline,
    powerHistory,
    dailyEnergyBar
  };
}

router.get('/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title', 'dashboard_logo', 'dashboard_favicon', 'dashboard_bg_color', 'dashboard_bg_color_light', 'dashboard_bg_color_dark', 'dashboard_bg_image', 'transparent_blocks', 'desktop_dashboard', 'mobile_dashboard', 'savings_currency', 'savings_rate', 'solar_capacity_kwp'];
    const config = {};
    for (const key of keys) config[key] = getConfig(key);
    config.dashboard_title = config.dashboard_title || '⚡ Epilykos';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
    res.set('Cache-Control', 'public, max-age=300');
    res.json(config);
  } catch (err) {
    logger.error('Error in /api/public-config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/current', async (req, res) => {
  try {
    const current = buildCurrentData(getDb());
    res.set('Cache-Control', 'public, max-age=10');
    if (current) {
      res.json({ ...current, metric_sanity: metricSanity.getStatus() });
    } else {
      res.json({ error: 'No data yet' });
    }
  } catch (err) {
    logger.error('Error in /api/current:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history/power-stats', (req, res) => {
  const invalid = message => res.status(400).json({ error: { code: 'invalid_request', message } });
  const integerParam = value => typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const from = integerParam(req.query.from), to = integerParam(req.query.to);
  if (from === null || to === null) return invalid('from and to must be safe integer Unix epoch seconds');
  if (from >= to) return invalid('from must be less than to');
  if (to - from > 7 * 86400) return invalid('range must not exceed 7 days');
  if (typeof req.query.fields !== 'string' || !req.query.fields.trim()) return invalid('fields must be a comma-separated list');
  const fields = [...new Set(req.query.fields.split(',').map(value => value.trim()).filter(Boolean))];
  if (!fields.length || fields.length > 7) return invalid('fields must contain 1 to 7 unique field IDs');
  try { res.json(readPowerStats(getDb(), { from, to, fields })); }
  catch (err) { logger.error('Error in /api/history/power-stats:', err); res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } }); }
});

router.get('/history', async (req, res) => {
  const requestedDays = parseInt(req.query.days);
  if (isNaN(requestedDays) || requestedDays < 1) return res.status(400).json({ error: 'days must be a positive integer (1-7)' });
  const days = Math.min(requestedDays, 7);
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const db = getDb();
    const rows = readHistorySeries(db, { from: since, to: now, toInclusive: true, fields: ['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc', 'daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export'] });
    res.json(rows.map(r => ({
      timestamp: r.timestamp,
      consumption: r.consumption, solar: r.solar, battery_charge: r.battery_charge,
      battery_discharge: r.battery_discharge, grid_import: r.grid_import, grid_export: r.grid_export,
      battery_soc: r.battery_soc, daily_consumption: r.daily_consumption, daily_solar: r.daily_solar,
      daily_battery_charge: r.daily_battery_charge, daily_battery_discharge: r.daily_battery_discharge,
      daily_grid_import: r.daily_grid_import, daily_grid_export: r.daily_grid_export,
      consumption_kw: r.consumption / 1000,
      solar_kw: r.solar / 1000,
      battery_charge_kw: r.battery_charge / 1000,
      battery_discharge_kw: r.battery_discharge / 1000,
      battery_power_kw: (r.battery_charge - r.battery_discharge) / 1000,
      grid_import_kw: r.grid_import / 1000,
      grid_export_kw: r.grid_export / 1000,
      timestamp: r.timestamp * 1000
    })));
  } catch (err) {
    logger.error('Error in /api/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/daily', async (req, res) => {
  const requestedDays = parseInt(req.query.days);
  if (isNaN(requestedDays) || requestedDays < 1) return res.status(400).json({ error: 'days must be a positive integer (1-365)' });
  const days = Math.min(requestedDays, 365);
  const now = new Date();
  const dateArray = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateArray.push(localDateString(d));
  }
  const startUnix = Math.floor(new Date(dateArray[0] + 'T00:00:00').getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  try {
    const db = getDb();
    const rows = readDailySnapshots(db, { from: startUnix, to: endUnix, toInclusive: true, fields: ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export'] }).map(r => ({ day: r.day, consumption_kwh: r.daily_consumption, solar_kwh: r.daily_solar, battery_charge_kwh: r.daily_battery_charge, battery_discharge_kwh: r.daily_battery_discharge, grid_import_kwh: r.daily_grid_import, grid_export_kwh: r.daily_grid_export }));
    const dataMap = {};
    rows.forEach(r => { dataMap[r.day] = r; });
    const result = dateArray.map(date => {
      const d = dataMap[date];
      return {
        day: date,
        consumption_kwh: d?.consumption_kwh || 0,
        solar_kwh: d?.solar_kwh || 0,
        battery_charge_kwh: d?.battery_charge_kwh || 0,
        battery_discharge_kwh: d?.battery_discharge_kwh || 0,
        grid_import_kwh: d?.grid_import_kwh || 0,
        grid_export_kwh: d?.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/daily:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/monthly', async (req, res) => {
  try {
    const now = new Date();
    const months = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        display: `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`
      });
    }
    const db = getDb();
    const dailyRows = readDailySnapshots(db, { fields: ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export'] });
    const monthTotals = new Map();
    for (const r of dailyRows) {
      const month = r.day.slice(0, 7);
      const total = monthTotals.get(month) || { month, consumption_kwh: 0, solar_kwh: 0, battery_charge_kwh: 0, battery_discharge_kwh: 0, grid_import_kwh: 0, grid_export_kwh: 0 };
      total.consumption_kwh += r.daily_consumption || 0; total.solar_kwh += r.daily_solar || 0; total.battery_charge_kwh += r.daily_battery_charge || 0; total.battery_discharge_kwh += r.daily_battery_discharge || 0; total.grid_import_kwh += r.daily_grid_import || 0; total.grid_export_kwh += r.daily_grid_export || 0;
      monthTotals.set(month, total);
    }
    const rows = [...monthTotals.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12);
    const dataMap = {};
    rows.forEach(r => { dataMap[r.month] = r; });
    const result = months.map(m => {
      const d = dataMap[m.key];
      return {
        month: m.key,
        display: m.display,
        consumption_kwh: d?.consumption_kwh || 0,
        solar_kwh: d?.solar_kwh || 0,
        battery_charge_kwh: d?.battery_charge_kwh || 0,
        battery_discharge_kwh: d?.battery_discharge_kwh || 0,
        grid_import_kwh: d?.grid_import_kwh || 0,
        grid_export_kwh: d?.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/monthly:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/grid/status', async (req, res) => {
  try {
    res.json(await getCurrentGridStatus());
  } catch (err) {
    logger.error('Error in /api/grid/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/grid/timeline', async (req, res) => {
  try {
    const period = req.query.period || '24h';
    res.json(await getGridTimeline(period));
  } catch (err) {
    logger.error('Error in /api/grid/timeline:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/savings', async (req, res) => {
  try {
    res.json(await getSavings());
  } catch (err) {
    logger.error('Error in /api/savings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/solar-forecast', async (req, res) => {
  try {
    // S5-front-A: per-card rest_map from dashboard config (JSON string).
    // Missing/malformed/non-object -> {} (backend identity aliases apply).
    let restMap = {};
    const rawMap = req.query.rest_map;
    if (rawMap != null && rawMap !== '') {
      try {
        const parsed = JSON.parse(rawMap);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) restMap = parsed;
      } catch { restMap = {}; }
    }
    res.json(await getSolarForecast(req.query.source, restMap));
  } catch (err) {
    logger.error('Error in /api/solar-forecast:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/solar/intraday', async (req, res) => {
  try {
    const field = req.query.field || 'solar';
    const allowed = ['solar', 'consumption', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export'];
    if (!allowed.includes(field)) return res.status(400).json({ error: `Invalid field. Allowed: ${allowed.join(', ')}` });
    const now = new Date();
    const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const db = getDb();
    const rows = db.prepare(`SELECT timestamp, ${field} as watts, daily_solar FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`).all(todayStart);
    res.json(rows.map(r => ({ timestamp: r.timestamp, watts: r.watts, daily_solar: r.daily_solar })));
  } catch (err) {
    logger.error('Error in /api/solar/intraday:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/dashboard-state', async (req, res) => {
  try {
    const state = await buildDashboardState();
    res.json(state);
  } catch (err) {
    logger.error('Aggregated state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/dashboard-config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const config = getDashboardConfig();
    res.json(config);
  } catch (err) {
    logger.error('Error fetching dashboard config:', err);
    const fallback = {
      dashboards: [{ id: 'main', name: 'Main', layout: [] }],
      activeDashboard: 'main'
    };
    res.status(500).json(fallback);
  }
});

module.exports = { router, buildDashboardState };
