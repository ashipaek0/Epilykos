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
const { computeSavings } = require('../modules/solarValue');
const { readHourlyEnergy } = require('../modules/energyHourly');
const { hourlyForecast, projectBattery } = require('../modules/energyForecast');

const { getCurrentMetrics } = require('../modules/metrics');

const router = express.Router();

const POWER_HISTORY_BUCKET_SECONDS = 600;
const POWER_HISTORY_FIELDS = ['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc', 'generator'];

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
  const savings = computeSavings({ todaySolarKwh: dailySolarKwh, db });
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
    generator_kw: (latest.generator || 0) / 1000,
    daily_generator_kwh: latest.daily_generator,
    savings_currency: savings.currency,
    savings_rate: savings.rate,
    generator_price: savings.generatorPrice,
    today_savings: savings.today,
    all_time_savings: savings.all,
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
    Promise.resolve(readDailySnapshots(db, { from: barSince, to: now, toInclusive: true, fields: ['daily_solar', 'daily_consumption', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export', 'daily_generator'] }).map(r => ({ day: r.day, solar_kwh: r.daily_solar, consumption_kwh: r.daily_consumption, battery_charge_kwh: r.daily_battery_charge, battery_discharge_kwh: r.daily_battery_discharge, grid_import_kwh: r.daily_grid_import, grid_export_kwh: r.daily_grid_export, generator_kwh: r.daily_generator })))
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
    grid_export_kw: r.grid_export / 1000,
    generator_kw: (r.generator || 0) / 1000,
    battery_soc: r.battery_soc ?? null
  }));

  const dailyEnergyBar = barRows.map(r => ({
    day: r.day,
    solar_kwh: r.solar_kwh,
    consumption_kwh: r.consumption_kwh,
    battery_charge_kwh: r.battery_charge_kwh,
    battery_discharge_kwh: r.battery_discharge_kwh,
    grid_import_kwh: r.grid_import_kwh,
    grid_export_kwh: r.grid_export_kwh,
    generator_kwh: r.generator_kwh
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
    dailyEnergyBar,
    breakdowns: safeBreakdowns()
  };
}

/**
 * The dashboard state for page loads: a page asks for it over HTTP and again
 * when its live connection opens, and the editor asks twice, so builds a
 * moment apart share one. The polling broadcast still builds fresh.
 */
const SHARED_STATE_MS = 2000;
let sharedState = null;   // { at, promise }
function sharedDashboardState() {
  if (sharedState && Date.now() - sharedState.at < SHARED_STATE_MS) return sharedState.promise;
  const entry = { at: Date.now(), promise: buildDashboardState() };
  entry.promise.catch(() => { if (sharedState === entry) sharedState = null; });
  sharedState = entry;
  return entry.promise;
}

// The parts behind combined totals, for cards that can show them (never fails the state).
function safeBreakdowns() {
  try { return require('../modules/combinedMetrics').buildBreakdowns(); }
  catch (err) { logger.warn('[dashboard] breakdowns unavailable:', err.message); return { metrics: {}, roles: {} }; }
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

// Hourly kWh, energy flows, battery charge and costs for one local day.
router.get('/energy/hourly', async (req, res) => {
  const date = req.query.date ? String(req.query.date) : localDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + 'T12:00:00').getTime())) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'date must be YYYY-MM-DD' } });
  }
  const price = key => { const n = parseFloat(getConfig(key)); return Number.isFinite(n) && n >= 0 ? n : 0; };
  try {
    const out = readHourlyEnergy(getDb(), { date, prices: { buy: price('savings_rate'), sell: price('energy_sell_price'), batteryWear: price('battery_wear_cost'), generator: price('generator_price') } });
    out.currency = getConfig('savings_currency') || '';
    // ?forecast=1 adds consumption, base load and solar forecasts per hour.
    if (req.query.forecast === '1') {
      let solar = null;
      if (date >= localDateString()) { try { solar = await getSolarForecast(); } catch (err) { logger.warn('[energy/hourly] solar forecast unavailable:', err.message); } }
      out.forecast = hourlyForecast(getDb(), { date, solarForecast: solar });
      if (date === localDateString()) out.forecast.battery = projectBattery(out, out.forecast, { capacityKwh: price('battery_capacity_kwh'), minSoc: price('battery_min_soc') });
    }
    res.json(out);
  } catch (err) {
    logger.error('Error in /api/energy/hourly:', err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  }
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

// Daily role -> table column.
const PART_FIELDS = { daily_consumption: 'consumption_kwh', daily_solar: 'solar_kwh', daily_battery_charge: 'battery_charge_kwh', daily_battery_discharge: 'battery_discharge_kwh', daily_grid_import: 'grid_import_kwh', daily_grid_export: 'grid_export_kwh' };
/**
 * Add `parts` to table rows: for each column whose daily role is a combined
 * total with recorded parts, { [field]: [{ label, value, parts? }] } with the
 * kWh of the row's days added up. Rows without recorded parts get none.
 */
function attachParts(rows, fromDay, toDay, daysOf) {
  let byRole;
  try { byRole = require('../modules/combinedMetrics').partDays(fromDay, toDay); } catch (err) { logger.warn('[tables] parts unavailable:', err.message); return; }
  for (const [role, info] of Object.entries(byRole)) {
    const field = PART_FIELDS[role]; if (!field) continue;
    for (const row of rows) {
      const days = daysOf(row).filter(d => info.days[d]);
      if (!days.length) continue;
      const fill = tree => tree.map(p => {
        const o = { label: p.label, value: Math.round(days.reduce((s, d) => s + (info.days[d][p.metric] || 0), 0) * 1000) / 1000 };
        if (p.parts) o.parts = fill(p.parts);
        return o;
      });
      (row.parts = row.parts || {})[field] = fill(info.tree);
      // A month whose parts start part-way (recording began then, or gaps):
      // say from when, since its total covers every day.
      const all = daysOf(row), today = localDateString();
      if (all.length > 1 && all.some(d => d < days[0] && d <= today)) (row.partsSince = row.partsSince || {})[field] = days[0];
    }
  }
}

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
    const rows = readDailySnapshots(db, { from: startUnix, to: endUnix, toInclusive: true, fields: ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export', 'daily_generator'] }).map(r => ({ day: r.day, consumption_kwh: r.daily_consumption, solar_kwh: r.daily_solar, battery_charge_kwh: r.daily_battery_charge, battery_discharge_kwh: r.daily_battery_discharge, grid_import_kwh: r.daily_grid_import, grid_export_kwh: r.daily_grid_export, generator_kwh: r.daily_generator }));
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
        grid_export_kwh: d?.grid_export_kwh || 0,
        generator_kwh: d?.generator_kwh || 0
      };
    });
    attachParts(result, dateArray[0], dateArray[dateArray.length - 1], row => [row.day]);
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
    const dailyRows = readDailySnapshots(db, { fields: ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export', 'daily_generator'], cached: true });
    const monthTotals = new Map();
    for (const r of dailyRows) {
      const month = r.day.slice(0, 7);
      const total = monthTotals.get(month) || { month, consumption_kwh: 0, solar_kwh: 0, battery_charge_kwh: 0, battery_discharge_kwh: 0, grid_import_kwh: 0, grid_export_kwh: 0, generator_kwh: 0 };
      total.generator_kwh += r.daily_generator || 0;
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
        grid_export_kwh: d?.grid_export_kwh || 0,
        generator_kwh: d?.generator_kwh || 0
      };
    });
    // Each month's parts are the sum of its days.
    const monthDays = key => { const [y, mo] = key.split('-').map(Number); const n = new Date(y, mo, 0).getDate(); return Array.from({ length: n }, (_, i) => `${key}-${String(i + 1).padStart(2, '0')}`); };
    attachParts(result, `${months[0].key}-01`, `${months[months.length - 1].key}-31`, row => monthDays(row.month));
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
    const state = await sharedDashboardState();
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

module.exports = { router, buildDashboardState, sharedDashboardState };
