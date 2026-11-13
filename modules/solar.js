const { logger } = require('./logger');
const https = require('https');
const databaseWork = require('./databaseWork');
const { getConfig, setConfig, getDb, flushMetrics, queueMetricValue } = require('./database');
const { localDateString } = require('./localTime');
const { readMetricSeries, readHistorySeries, readDailySnapshots } = require('./timeseriesReader');

let forecastCache = {}; // S1-prime: per-selector entries { <selector>: { data, timestamp } }
let solarCache = { value: 0, timestamp: 0 };
const FORECAST_CACHE_MS = 3 * 60 * 60 * 1000;
const SOLAR_CACHE_MS = 30000; // 30s TTL

// ---- Issue #127 follow-up: Solcast negative-cache + upstream gate ----
// Per-selector negative cache entry:
//   { errorText, firstFailure, retryAt, lastGood, lastGoodData, cachedError: true }
// Global upstream gate: allow max 1 Solcast attempt per 60min across ALL selectors.
let solcastNegativeCache = {}; // selector -> negative entry
let solcastLastUpstreamAttempt = 0; // epoch ms of last upstream Solcast fetch attempt
const SOLCAST_UPSTREAM_GATE_MS = 60 * 60 * 1000; // 60 min gate

// TTL constants for negative cache
const SOLCAST_NEGATIVE_TTL_TRANSPORT_MS = 30 * 60 * 1000;   // 30 min: transport/5xx/empty
const SOLCAST_NEGATIVE_TTL_429_BASE_MS = 120 * 60 * 1000;   // 120 min: 429 without Retry-After
const SOLCAST_NEGATIVE_TTL_MAX_MS = 6 * 60 * 60 * 1000;     // 6 hr: cap

// Solcast requests: fixed host, encoded path/query, and the API key in the
// Authorization header — never in the URL, where it would reach logs.
const SOLCAST_BASE = 'https://api.solcast.com.au';

function solcastRooftopUrl(resourceId) {
  const url = new URL(`/rooftop_sites/${encodeURIComponent(String(resourceId))}/forecasts`, SOLCAST_BASE);
  url.searchParams.set('format', 'json');
  return url;
}

// The location-based forecasts use Solcast's current API and response format (version 3: explicit time offsets
// in period_end). The old /world_pv_power/forecasts path and its legacy format are retired by Solcast on
// 1 February 2027. The site (rooftop resource) forecast above is a separate endpoint and stays as it is.
const SOLCAST_FORMAT = 'json;version=3';
const SOLCAST_FORECAST_HOURS = 168;   // seven days: what the app shows, so no more is fetched
const SOLCAST_PV_PARAMS = ['pv_power_rooftop', 'pv_power_rooftop10', 'pv_power_rooftop90'];
// Every weather and irradiance parameter Solcast's forecast accepts (docs.solcast.com.au/docs/output-parameters).
const SOLCAST_WEATHER_PARAMS = [
  'air_temp', 'min_air_temp', 'max_air_temp', 'dewpoint_temp', 'relative_humidity',
  'ghi', 'ghi10', 'ghi90', 'dni', 'dni10', 'dni90', 'dhi', 'dhi10', 'dhi90', 'gti', 'gti10', 'gti90',
  'clearsky_ghi', 'clearsky_dni', 'clearsky_dhi', 'clearsky_gti',
  'cloud_opacity', 'cloud_opacity10', 'cloud_opacity90', 'albedo', 'azimuth', 'zenith',
  'wind_speed_10m', 'wind_speed_100m', 'wind_direction_10m', 'wind_direction_100m', 'wind_gust',
  'precipitation_rate', 'snowfall_rate', 'snow_depth', 'snow_water_equivalent', 'snow_soiling_rooftop', 'snow_soiling_ground',
  'surface_pressure', 'precipitable_water', 'cape', 'weather_type', 'pm10', 'pm2.5'
];
// If Solcast rejects the full list (a parameter this account or endpoint does not take), the well-established ones.
const SOLCAST_WEATHER_CORE = ['air_temp', 'relative_humidity', 'ghi', 'ghi10', 'ghi90', 'dni', 'dhi', 'cloud_opacity', 'wind_speed_10m', 'precipitation_rate', 'surface_pressure', 'zenith', 'azimuth'];

function solcastPvUrl({ latitude, longitude, capacity, tilt, azimuth, loss_factor, install_date }) {
  const url = new URL('/data/forecast/rooftop_pv_power', SOLCAST_BASE);
  const params = { latitude, longitude, capacity, tilt, azimuth, loss_factor, install_date, hours: SOLCAST_FORECAST_HOURS, period: 'PT30M', output_parameters: SOLCAST_PV_PARAMS.join(',') };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('format', SOLCAST_FORMAT);
  return url;
}

function solcastWeatherUrl({ latitude, longitude, tilt, azimuth }, params = SOLCAST_WEATHER_PARAMS) {
  const url = new URL('/data/forecast/radiation_and_weather', SOLCAST_BASE);
  const q = { latitude, longitude, tilt, azimuth, hours: SOLCAST_FORECAST_HOURS, period: 'PT30M', output_parameters: params.join(',') };
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
  url.searchParams.set('format', SOLCAST_FORMAT);
  return url;
}

// ---- Solcast request budget ----
// A plan allows a number of requests per UTC day (10 for a hobbyist account). Every request this module makes is
// counted, and the optional weather request is made only when it leaves room for the PV refreshes still due today.
const SOLCAST_USAGE_KEY = 'solcast_requests';
const SOLCAST_DEFAULT_DAILY_LIMIT = 10;
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
function solcastDailyLimit() {
  const n = parseInt(getConfig('solcast_daily_limit'), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : SOLCAST_DEFAULT_DAILY_LIMIT;
}
function solcastRequestsToday(ms = Date.now()) {
  try { const u = JSON.parse(getConfig(SOLCAST_USAGE_KEY) || 'null'); return u && u.day === utcDay(ms) ? Number(u.count) || 0 : 0; } catch (_) { return 0; }
}
function noteSolcastRequest(ms = Date.now()) {
  try { setConfig(SOLCAST_USAGE_KEY, JSON.stringify({ day: utcDay(ms), count: solcastRequestsToday(ms) + 1 })); } catch (_) { /* counting is best effort */ }
}
/** Whether one more request fits today without starving the PV refreshes (one per FORECAST_CACHE_MS) still due. */
function solcastBudgetAllows(pvJobs = 1, ms = Date.now()) {
  const untilMidnight = Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1) - ms;
  const reserve = Math.ceil(untilMidnight / FORECAST_CACHE_MS) * Math.max(1, pvJobs);
  return solcastRequestsToday(ms) + 1 + reserve <= solcastDailyLimit();
}

function solcastFetch(url, apiKey) {
  noteSolcastRequest();
  return fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
}

function computeSolarForDate(dateStr) {
  const db = getDb();
  const startOfDay = new Date(dateStr + 'T00:00:00');
  const endOfDay = new Date(dateStr + 'T23:59:59');
  const startUnix = Math.floor(startOfDay.getTime() / 1000);
  const endUnix = Math.floor(endOfDay.getTime() / 1000);
  const rows = readHistorySeries(db, { from: startUnix, to: endUnix, toInclusive: true, fields: ['solar'] });
  let totalKwh = 0;
  if (rows.length >= 2) {
    for (let i = 0; i < rows.length - 1; i++) {
      const dtHours = (rows[i+1].timestamp - rows[i].timestamp) / 3600;
      const avgKw = (rows[i].solar + rows[i+1].solar) / 2000;
      totalKwh += avgKw * dtHours;
    }
    const last = rows[rows.length-1];
    const dtLastHours = (endUnix - last.timestamp) / 3600;
    if (dtLastHours > 0 && last.timestamp < endUnix) totalKwh += (last.solar / 1000) * dtLastHours;
  }
  // Fallback: if integration returned nothing, use daily_solar from history
  if (totalKwh <= 0) {
    const ds = readDailySnapshots(db, { from: startUnix, to: endUnix, toInclusive: true, fields: ['daily_solar'] }).reduce((best, row) => Math.max(best, row.daily_solar || 0), 0);
    if (ds > 0) totalKwh = ds;
  }
  return totalKwh;
}

/**
 * Energy produced today, in kWh. Cached for 30 s unless `fresh` is set: the
 * dashboard state build asks for a fresh figure each cycle, so the number it
 * pushes is from the same moment as the live readings beside it.
 */
function computeTodaySolar({ fresh = false } = {}) {
  const db = getDb();
  const nowMs = Date.now();
  // Cache hit within 30s TTL (only if we have a real value)
  if (!fresh && solarCache.value > 0 && (nowMs - solarCache.timestamp) < SOLAR_CACHE_MS) {
    return solarCache.value;
  }

  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(nowMs / 1000);

  var computed = 0;
  var done = false;

  flushMetrics(); // read-your-write: pollers queue their writes
  const configured = (getConfig('savings_solar_metric') || '').trim();

  // 1. User-configured metric — check latest_metrics (treat as cumulative kWh)
  if (configured) {
    const row = db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get(configured);
    if (row && row.value > 0) { computed = row.value; done = true; }
    if (!done) {
      const rows = readMetricSeries(db, { metric: configured, from: startUnix, to: endUnix, toInclusive: true });
      if (rows.length >= 2) { computed = integrateWattsToKwh(rows.map(row => ({ timestamp: row.timestamp, value: row.value })), endUnix); done = true; }
    }
  }

  // 2. Auto-detect: scan latest_metrics once for both daily-energy and power metrics
  if (!done) {
    const allMetrics = db.prepare('SELECT metric, value FROM latest_metrics').all();
    // 2a. Daily energy candidates: metric name containing solar/pv + (gen|daily|today|cumulative)
    const dailyCandidates = allMetrics.filter(function(r) {
      var n = r.metric.toLowerCase();
      return (n.indexOf('solar') !== -1 || n.indexOf('pv') !== -1) && (n.indexOf('gen') !== -1 || n.indexOf('daily') !== -1 || n.indexOf('today') !== -1 || n.indexOf('cumulative') !== -1);
    });
    for (var i = 0; i < dailyCandidates.length; i++) {
      if (dailyCandidates[i].value > 0) { computed = dailyCandidates[i].value; done = true; break; }
    }

    // 2b. Power candidates: integrate any metric whose name suggests solar power
    if (!done) {
      for (let i = 0; i < allMetrics.length; i++) {
        var n = allMetrics[i].metric.toLowerCase();
        if (n.indexOf('solar') !== -1 && (n.indexOf('power') !== -1 || n.indexOf('watts') !== -1 || n.indexOf('kw') !== -1)) {
          const rows = readMetricSeries(db, { metric: allMetrics[i].metric, from: startUnix, to: endUnix, toInclusive: true });
          if (rows.length >= 2) { computed = integrateWattsToKwh(rows.map(row => ({ timestamp: row.timestamp, value: row.value })), endUnix); done = true; break; }
        }
      }
    }
  }

  // 4. Fall back to history table (HA/MQTT legacy path)
  if (!done) {
    const histRows = readHistorySeries(db, { from: startUnix, to: endUnix, toInclusive: true, fields: ['solar'] }).map(row => ({ timestamp: row.timestamp, value: row.solar }));
    if (histRows.length >= 2) computed = integrateWattsToKwh(histRows, endUnix);
  }

  // Write to cache
  solarCache = { value: computed, timestamp: nowMs };
  return computed;
}

/** Trapezoidal integration: timestamped wattage rows → kWh */
function integrateWattsToKwh(rows, endUnix) {
  let totalKwh = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const dtHours = (rows[i+1].timestamp - rows[i].timestamp) / 3600;
    const avgKw = (rows[i].value + rows[i+1].value) / 2000;
    totalKwh += avgKw * dtHours;
  }
  const last = rows[rows.length - 1];
  const dtLastHours = (endUnix - last.timestamp) / 3600;
  if (dtLastHours > 0) totalKwh += (last.value / 1000) * dtLastHours;
  return totalKwh;
}

// ---- WMO weather codes (Open-Meteo) → description + day/night icon ----
// Every code Open-Meteo documents is covered; unknown codes fall back to a
// neutral cloud rather than claiming "Clear Sky".
const WMO_CODES = {
  0: { desc: 'Clear Sky', day: 'fi-sr-sun', night: 'fi-sr-moon' },
  1: { desc: 'Mainly Clear', day: 'fi-sr-sun', night: 'fi-sr-moon-stars' },
  2: { desc: 'Partly Cloudy', day: 'fi-sr-cloud-sun', night: 'fi-sr-cloud-moon' },
  3: { desc: 'Overcast', day: 'fi-sr-clouds', night: 'fi-sr-clouds' },
  45: { desc: 'Fog', day: 'fi-sr-fog', night: 'fi-sr-fog' },
  48: { desc: 'Rime Fog', day: 'fi-sr-fog', night: 'fi-sr-fog' },
  51: { desc: 'Light Drizzle', day: 'fi-sr-cloud-drizzle', night: 'fi-sr-cloud-drizzle' },
  53: { desc: 'Drizzle', day: 'fi-sr-cloud-drizzle', night: 'fi-sr-cloud-drizzle' },
  55: { desc: 'Dense Drizzle', day: 'fi-sr-cloud-drizzle', night: 'fi-sr-cloud-drizzle' },
  56: { desc: 'Freezing Drizzle', day: 'fi-sr-cloud-sleet', night: 'fi-sr-cloud-sleet' },
  57: { desc: 'Freezing Drizzle', day: 'fi-sr-cloud-sleet', night: 'fi-sr-cloud-sleet' },
  61: { desc: 'Light Rain', day: 'fi-sr-cloud-rain', night: 'fi-sr-cloud-rain' },
  63: { desc: 'Rain', day: 'fi-sr-cloud-rain', night: 'fi-sr-cloud-rain' },
  65: { desc: 'Heavy Rain', day: 'fi-sr-cloud-showers-heavy', night: 'fi-sr-cloud-showers-heavy' },
  66: { desc: 'Freezing Rain', day: 'fi-sr-cloud-sleet', night: 'fi-sr-cloud-sleet' },
  67: { desc: 'Freezing Rain', day: 'fi-sr-cloud-sleet', night: 'fi-sr-cloud-sleet' },
  71: { desc: 'Light Snow', day: 'fi-sr-cloud-snow', night: 'fi-sr-cloud-snow' },
  73: { desc: 'Snow', day: 'fi-sr-cloud-snow', night: 'fi-sr-cloud-snow' },
  75: { desc: 'Heavy Snow', day: 'fi-sr-snowflakes', night: 'fi-sr-snowflakes' },
  77: { desc: 'Snow Grains', day: 'fi-sr-snowflake', night: 'fi-sr-snowflake' },
  80: { desc: 'Rain Showers', day: 'fi-sr-cloud-sun-rain', night: 'fi-sr-cloud-moon-rain' },
  81: { desc: 'Rain Showers', day: 'fi-sr-cloud-showers', night: 'fi-sr-cloud-showers' },
  82: { desc: 'Violent Showers', day: 'fi-sr-cloud-showers-heavy', night: 'fi-sr-cloud-showers-heavy' },
  85: { desc: 'Snow Showers', day: 'fi-sr-cloud-snow', night: 'fi-sr-cloud-snow' },
  86: { desc: 'Heavy Snow Showers', day: 'fi-sr-snowflakes', night: 'fi-sr-snowflakes' },
  95: { desc: 'Thunderstorm', day: 'fi-sr-thunderstorm-sun', night: 'fi-sr-thunderstorm-moon' },
  96: { desc: 'Thunderstorm, Hail', day: 'fi-sr-cloud-hail', night: 'fi-sr-cloud-hail' },
  99: { desc: 'Thunderstorm, Heavy Hail', day: 'fi-sr-cloud-hail', night: 'fi-sr-cloud-hail' }
};

/** Description + icon class for a WMO code; isDay false → night icon. */
function describeWeatherCode(code, isDay = true) {
  const n = Number(code);
  const entry = (code != null && Number.isFinite(n)) ? WMO_CODES[n] : null;
  if (!entry) return { code: null, desc: '', icon_class: 'fi fi-sr-cloud' };
  return { code: n, desc: entry.desc, icon_class: 'fi ' + (isDay === false ? entry.night : entry.day) };
}

// Legacy shape kept for callers/tests that import it: code → { icon, desc }.
const weatherCodeMap = Object.fromEntries(Object.keys(WMO_CODES).map(k => [k, { icon: 'fi ' + WMO_CODES[k].day, desc: WMO_CODES[k].desc }]));
const DEFAULT_WEATHER = { icon: 'fi fi-sr-cloud', desc: '' };

// ---- Open-Meteo: ONE request for current, hourly and 7-day data ----
const OPEN_METEO_CACHE_MS = 15 * 60 * 1000;
let openMeteoCache = { key: null, data: null, timestamp: 0 };
// ---- Today's earlier forecast periods ----
// Solcast only returns periods from "now" onwards, so the morning of today's
// forecast would vanish from the cards as the day goes on (the dotted line
// starting at "now", today's total shrinking). Remember every period seen for
// today, per source, and put the earlier ones back in front of each fetch.
// Kept in config so a restart doesn't lose the morning.
const TODAY_PERIODS_KEY = 'forecast_today_periods';
const KEPT_PERIOD_FIELDS = ['period', 'period_end', 'pv_estimate', 'pv_estimate10', 'pv_estimate90', 'cloud_cover', 'air_temp', 'weather_code', 'is_day', 'precip_rate', ...SOLCAST_WEATHER_PARAMS];
let todayPeriods = null; // { date, sources: { [source]: { [endMs]: period } } }

function loadTodayPeriods(today) {
  if (todayPeriods && todayPeriods.date === today) return todayPeriods;
  let saved = null;
  try { saved = JSON.parse(getConfig(TODAY_PERIODS_KEY) || 'null'); } catch (_) { saved = null; }
  todayPeriods = (saved && saved.date === today && saved.sources && typeof saved.sources === 'object')
    ? saved : { date: today, sources: {} };
  return todayPeriods;
}

function periodEndMs(p) {
  const t = new Date(p && p.period_end).getTime();
  return Number.isFinite(t) ? t : null;
}

/** periods (fresh from a source) → today's remembered earlier periods + periods. */
function withTodaysEarlierPeriods(source, periods) {
  if (!Array.isArray(periods) || !periods.length) return periods;
  const today = localDateString();
  const mem = loadTodayPeriods(today);
  const bySource = mem.sources[source] || (mem.sources[source] = {});
  let changed = false;
  for (const p of periods) {
    const ms = periodEndMs(p);
    if (ms == null || localDateString(new Date(ms)) !== today) continue;
    const kept = {};
    for (const k of KEPT_PERIOD_FIELDS) if (p[k] !== undefined) kept[k] = p[k];
    bySource[ms] = kept;
    changed = true;
  }
  const firstFresh = Math.min(...periods.map(periodEndMs).filter(ms => ms != null));
  const earlier = Object.keys(bySource).map(Number)
    .filter(ms => ms < firstFresh)
    .sort((a, b) => a - b)
    .map(ms => ({ ...bySource[ms], earlier: true }));
  if (changed) {
    try { setConfig(TODAY_PERIODS_KEY, JSON.stringify(mem)); } catch (e) { logger.warn(`[forecast] could not save today's periods: ${e.message}`); }
  }
  return earlier.length ? earlier.concat(periods) : periods;
}

/**
 * Fill weather on forecast periods that lack it (Solcast rooftop periods carry
 * no weather code and often no cloud cover) from Open-Meteo's hourly data, so
 * the PV Today weather row and cloud line have something to show.
 */
function fillPeriodWeather(periods, omHourly) {
  if (!Array.isArray(periods) || !Array.isArray(omHourly) || !omHourly.length) return;
  for (const p of periods) {
    if (p.weather_code != null && p.cloud_cover != null) continue;
    const end = periodEndMs(p);
    if (end == null) continue;
    const mid = end - periodHours(p) * 1800000; // middle of the period
    let best = null;
    for (const h of omHourly) {
      const d = Math.abs((h.ms - 1800000) - mid); // OM hourly values describe the hour ending at h.ms
      if (!best || d < best.d) best = { h, d };
    }
    if (!best || best.d > 3600000) continue;
    if (p.weather_code == null && best.h.code != null) p.weather_code = best.h.code;
    if (p.cloud_cover == null && best.h.cloud_cover != null) p.cloud_cover = best.h.cloud_cover;
    if (p.is_day == null && best.h.is_day != null) p.is_day = best.h.is_day;
  }
}

let lastGoodWeather = null; // served (flagged stale) when Open-Meteo fails

const OM_CURRENT = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'is_day',
  'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'precipitation', 'pressure_msl', 'uv_index'];
const OM_HOURLY = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'dew_point_2m',
  'precipitation_probability', 'precipitation', 'weather_code', 'cloud_cover', 'wind_speed_10m',
  'wind_direction_10m', 'wind_gusts_10m', 'shortwave_radiation', 'uv_index', 'is_day'];
const OM_DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max',
  'apparent_temperature_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max',
  'wind_gusts_10m_max', 'wind_direction_10m_dominant', 'uv_index_max', 'sunrise', 'sunset',
  'shortwave_radiation_sum', 'daylight_duration'];

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Column-oriented Open-Meteo block → array of row objects keyed by variable. */
function omRows(block) {
  if (!block || !Array.isArray(block.time)) return [];
  const keys = Object.keys(block).filter(k => k !== 'time' && Array.isArray(block[k]));
  return block.time.map((t, i) => {
    const row = { time: t };
    for (const k of keys) row[k] = block[k][i] ?? null;
    return row;
  });
}

/**
 * Normalise an Open-Meteo response (timeformat=unixtime) into
 * { current, hourly[], daily[] } with epoch-ms times and the location's
 * calendar dates for daily rows.
 */
function parseOpenMeteo(raw) {
  const offsetMs = (Number(raw && raw.utc_offset_seconds) || 0) * 1000;
  const toMs = (t) => (typeof t === 'number' ? t * 1000 : new Date(t).getTime());
  const dayOf = (t) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t))
    ? t : new Date(toMs(t) + offsetMs).toISOString().slice(0, 10);

  const hourly = omRows(raw && raw.hourly).map(r => ({
    ms: toMs(r.time),
    temp: numOrNull(r.temperature_2m),
    feels_like: numOrNull(r.apparent_temperature),
    humidity: numOrNull(r.relative_humidity_2m),
    dew_point: numOrNull(r.dew_point_2m),
    precip_probability: numOrNull(r.precipitation_probability),
    precip: numOrNull(r.precipitation),
    code: numOrNull(r.weather_code),
    cloud_cover: numOrNull(r.cloud_cover),
    wind_speed: numOrNull(r.wind_speed_10m),
    wind_direction: numOrNull(r.wind_direction_10m),
    wind_gusts: numOrNull(r.wind_gusts_10m),
    shortwave_radiation: numOrNull(r.shortwave_radiation),
    uv_index: numOrNull(r.uv_index),
    is_day: r.is_day == null ? null : Number(r.is_day) === 1
  })).filter(h => Number.isFinite(h.ms));

  const daily = omRows(raw && raw.daily).map(r => ({
    date: dayOf(r.time),
    code: numOrNull(r.weather_code),
    temp_max: numOrNull(r.temperature_2m_max),
    temp_min: numOrNull(r.temperature_2m_min),
    feels_max: numOrNull(r.apparent_temperature_max),
    feels_min: numOrNull(r.apparent_temperature_min),
    precip_sum: numOrNull(r.precipitation_sum),
    precip_probability: numOrNull(r.precipitation_probability_max),
    wind_max: numOrNull(r.wind_speed_10m_max),
    gusts_max: numOrNull(r.wind_gusts_10m_max),
    wind_direction: numOrNull(r.wind_direction_10m_dominant),
    uv_max: numOrNull(r.uv_index_max),
    sunrise: r.sunrise != null ? toMs(r.sunrise) : null,
    sunset: r.sunset != null ? toMs(r.sunset) : null,
    radiation_sum: numOrNull(r.shortwave_radiation_sum),
    daylight_s: numOrNull(r.daylight_duration)
  }));

  const c = (raw && raw.current) || null;
  const current = c ? {
    ms: c.time != null ? toMs(c.time) : Date.now(),
    temp: numOrNull(c.temperature_2m),
    feels_like: numOrNull(c.apparent_temperature),
    humidity: numOrNull(c.relative_humidity_2m),
    code: numOrNull(c.weather_code),
    is_day: c.is_day == null ? null : Number(c.is_day) === 1,
    cloud_cover: numOrNull(c.cloud_cover),
    wind_speed: numOrNull(c.wind_speed_10m),
    wind_direction: numOrNull(c.wind_direction_10m),
    wind_gusts: numOrNull(c.wind_gusts_10m),
    precip: numOrNull(c.precipitation),
    pressure: numOrNull(c.pressure_msl),
    uv_index: numOrNull(c.uv_index)
  } : null;

  return { current, hourly, daily, timezone: (raw && raw.timezone) || null };
}

/** Cached (15 min) single Open-Meteo request for a location. */
async function fetchOpenMeteo(lat, lon) {
  const key = `${lat},${lon}`;
  const now = Date.now();
  if (openMeteoCache.key === key && openMeteoCache.data && now - openMeteoCache.timestamp < OPEN_METEO_CACHE_MS) {
    return openMeteoCache.data;
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&timezone=auto&timeformat=unixtime&wind_speed_unit=ms&forecast_days=7'
    + `&current=${OM_CURRENT.join(',')}&hourly=${OM_HOURLY.join(',')}&daily=${OM_DAILY.join(',')}`;
  const data = parseOpenMeteo(await httpsGetJson(url));
  databaseWork.assertCurrent();
  openMeteoCache = { key, data, timestamp: now };
  return data;
}

/** Open-Meteo hourly → forecast periods (pv_estimate in kW, 1-hour periods). */
async function getOpenMeteoData(lat, lon, capacityKwp, lossFactor) {
  const om = await fetchOpenMeteo(lat, lon);
  if (!om.hourly.length) throw new Error('Open-Meteo returned no hourly data');
  // shortwave_radiation is the mean over the PRECEDING hour, so time = period end.
  const conversionFactor = (capacityKwp / 1000) * (lossFactor || 0.9);
  const forecasts = om.hourly.map(h => ({
    period_end: new Date(h.ms).toISOString(),
    period: 'PT60M',
    pv_estimate: (h.shortwave_radiation || 0) * conversionFactor,
    ghi: h.shortwave_radiation,
    shortwave_radiation: h.shortwave_radiation,
    cloud_cover: h.cloud_cover,
    air_temp: h.temp,
    relative_humidity: h.humidity,
    precip_rate: h.precip,
    precip_probability: h.precip_probability,
    wind_speed_10m: h.wind_speed,
    wind_direction_10m: h.wind_direction,
    weather_code: h.code,
    is_day: h.is_day,
    uv_index: h.uv_index
  }));
  return { forecasts, source: 'open-meteo' };
}

/**
 * The PV arrays to forecast. Config `solar_arrays` (Settings > Forecast) is a
 * list of { name, kwp, tilt, azimuth, solcast_resource_id }; azimuth is the
 * compass direction the panels face (180 = south). Without it, the single
 * array from solar_capacity_kwp / solar_tilt / solar_azimuth is used.
 * `override` (Test forecast) can pass `arrays`, or capacity/tilt/azimuth.
 */
function getArrays(override = {}) {
  const fromList = list => (Array.isArray(list) ? list : [])
    .map((a, i) => ({ name: String(a?.name || `Array ${i + 1}`).slice(0, 40), kwp: Number(a?.kwp), tilt: Number.isFinite(Number(a?.tilt)) ? Number(a.tilt) : 30, azimuth: Number.isFinite(Number(a?.azimuth)) ? Number(a.azimuth) : 180, solcast_resource_id: String(a?.solcast_resource_id || '').trim() }))
    .filter(a => a.kwp > 0 && a.tilt >= 0 && a.tilt <= 90);
  if (Array.isArray(override.arrays)) return fromList(override.arrays);
  if (override.capacity != null) return fromList([{ kwp: override.capacity, tilt: override.tilt ?? 30, azimuth: override.azimuth ?? 180 }]);
  let saved = [];
  try { saved = JSON.parse(getConfig('solar_arrays') || '[]'); } catch (_) { saved = []; }
  const list = fromList(saved);
  if (list.length) return list;
  return fromList([{ kwp: getConfig('solar_capacity_kwp'), tilt: parseFloat(getConfig('solar_tilt')) || 30, azimuth: parseFloat(getConfig('solar_azimuth')) || 180 }]);
}

/** Compass azimuth (180 = south) to Open-Meteo's (0 = south, -90 east, 90 west). */
function openMeteoAzimuth(compass) {
  let a = Number(compass) - 180;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

const tiltedCache = new Map(); // key -> { at, byMs: Map(ms -> W/m2) }
/** Hourly irradiance on a tilted plane (W/m2, mean of the preceding hour), keyed by time. */
async function fetchTiltedIrradiance(lat, lon, tilt, azimuth) {
  const key = `${lat},${lon},${tilt},${azimuth}`, now = Date.now(), hit = tiltedCache.get(key);
  if (hit && now - hit.at < OPEN_METEO_CACHE_MS) return hit.byMs;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&timeformat=unixtime&forecast_days=7`
    + `&hourly=global_tilted_irradiance&tilt=${tilt}&azimuth=${openMeteoAzimuth(azimuth)}`;
  const raw = await httpsGetJson(url);
  const t = raw?.hourly?.time || [], g = raw?.hourly?.global_tilted_irradiance || [];
  const byMs = new Map(t.map((x, i) => [x * 1000, numOrNull(g[i])]));
  databaseWork.assertCurrent();
  tiltedCache.set(key, { at: now, byMs });
  while (tiltedCache.size > 16) tiltedCache.delete(tiltedCache.keys().next().value);
  return byMs;
}

/**
 * Open-Meteo forecast for several arrays: each array's tilted irradiance x its
 * kWp x the loss factor, added up. An array whose tilted request fails falls
 * back to horizontal irradiance rather than dropping out.
 */
async function getOpenMeteoArrays(lat, lon, arrays, lossFactor) {
  const base = await getOpenMeteoData(lat, lon, 0, lossFactor);  // periods + weather, pv set below
  const loss = lossFactor || 0.9;
  const tilted = await Promise.all(arrays.map(a => fetchTiltedIrradiance(lat, lon, a.tilt, a.azimuth).catch(err => { logger.debug(`[forecast] tilted irradiance for ${a.name} unavailable: ${err.message}`); return null; })));
  base.forecasts.forEach(f => {
    const ms = new Date(f.period_end).getTime();
    f.pv_estimate = arrays.reduce((sum, a, i) => {
      const gti = tilted[i] ? tilted[i].get(ms) : null;
      return sum + (gti != null ? gti : (f.shortwave_radiation || 0)) * (a.kwp / 1000) * loss;
    }, 0);
  });
  base.arrays = arrays.map((a, i) => ({ name: a.name, kwp: a.kwp, tilted: !!tilted[i] }));
  return base;
}

/** Add Solcast forecasts from several arrays period by period (estimates and P10/P90 bands). */
function sumForecastPeriods(lists) {
  const byEnd = new Map();
  for (const list of lists) for (const f of list || []) {
    const key = f.period_end, prev = byEnd.get(key);
    if (!prev) { byEnd.set(key, { ...f }); continue; }
    for (const k of ['pv_estimate', 'pv_estimate10', 'pv_estimate90']) if (f[k] != null) prev[k] = (prev[k] || 0) + Number(f[k]);
  }
  return [...byEnd.values()].sort((a, b) => new Date(a.period_end) - new Date(b.period_end));
}

/** Hours covered by one forecast period ('PT30M' → 0.5); default 1 h. */
function periodHours(f) {
  const m = /^PT(\d+(?:\.\d+)?)([HM])$/i.exec(String((f && f.period) || ''));
  if (!m) return 1;
  const v = Number(m[1]);
  return m[2].toUpperCase() === 'H' ? v : v / 60;
}

/** Degrees → 16-point compass label. */
function compassPoint(deg) {
  const n = numOrNull(deg);
  if (n == null) return null;
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round((((n % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Build the weather object every weather/forecast card consumes from one
 * parsed Open-Meteo payload. Legacy keys (icon_class, desc, temp, extra,
 * forecast_weather[]) keep their meaning; everything else is additive.
 */
function buildOpenMeteoWeather(om) {
  const now = Date.now();
  const todayStr = localDateString();
  const cur = om.current || {};
  // Hour nearest "now" fills anything `current` did not return.
  const nearest = om.hourly.reduce((best, h) => (!best || Math.abs(h.ms - now) < Math.abs(best.ms - now) ? h : best), null) || {};
  const pick = (k) => (cur[k] != null ? cur[k] : (nearest[k] != null ? nearest[k] : null));
  const isDay = pick('is_day');
  const current = describeWeatherCode(pick('code'), isDay);
  const todayRow = om.daily.find(d => d.date === todayStr) || om.daily[0] || null;
  const dayOut = (d) => {
    const w = describeWeatherCode(d.code, true);
    const dt = new Date(d.date + 'T12:00:00');
    return {
      date: d.date,
      day_name: dt.toLocaleDateString('en-US', { weekday: 'long' }),
      icon_class: w.icon_class, desc: w.desc, code: w.code,
      temp: d.temp_max, temp_max: d.temp_max, temp_min: d.temp_min,
      feels_max: d.feels_max, feels_min: d.feels_min,
      precip_sum: d.precip_sum, precip_probability: d.precip_probability,
      wind_max: d.wind_max, gusts_max: d.gusts_max,
      wind_direction: d.wind_direction, wind_compass: compassPoint(d.wind_direction),
      uv_max: d.uv_max,
      sunrise: d.sunrise != null ? new Date(d.sunrise).toISOString() : null,
      sunset: d.sunset != null ? new Date(d.sunset).toISOString() : null,
      daylight_hours: d.daylight_s != null ? Math.round(d.daylight_s / 360) / 10 : null,
      extra: [d.feels_max != null ? `Feels ${d.feels_max.toFixed(0)}°C` : '',
        d.precip_probability != null ? `Rain ${d.precip_probability.toFixed(0)}%` : ''].filter(Boolean).join(' · ')
    };
  };
  const temp = pick('temp');
  const feels = pick('feels_like');
  const humidity = pick('humidity');
  return {
    available: true,
    updated_at: new Date(cur.ms || now).toISOString(),
    icon_class: current.icon_class,
    desc: current.desc,
    code: current.code,
    is_day: isDay,
    temp,
    feels_like: feels,
    humidity,
    wind_speed: pick('wind_speed'),
    wind_gusts: pick('wind_gusts'),
    wind_direction: pick('wind_direction'),
    wind_compass: compassPoint(pick('wind_direction')),
    cloud_cover: pick('cloud_cover'),
    precip: pick('precip'),
    precip_probability: nearest.precip_probability ?? null,
    pressure: cur.pressure ?? null,
    uv_index: pick('uv_index'),
    today: todayRow ? dayOut(todayRow) : null,
    sunrise: todayRow && todayRow.sunrise != null ? new Date(todayRow.sunrise).toISOString() : null,
    sunset: todayRow && todayRow.sunset != null ? new Date(todayRow.sunset).toISOString() : null,
    extra: buildWeatherExtra(feels, humidity),
    forecast_weather: om.daily.filter(d => d.date > todayStr).slice(0, 6).map(dayOut),
    hourly: om.hourly
      .filter(h => h.ms >= now - 30 * 60 * 1000)
      .slice(0, 24)
      .map(h => {
        const w = describeWeatherCode(h.code, h.is_day);
        return {
          time: new Date(h.ms).toISOString(), temp: h.temp, feels_like: h.feels_like,
          icon_class: w.icon_class, desc: w.desc, code: w.code,
          precip_probability: h.precip_probability, precip: h.precip,
          cloud_cover: h.cloud_cover, wind_speed: h.wind_speed, uv_index: h.uv_index, is_day: h.is_day
        };
      })
  };
}

function buildWeatherExtra(feels, humidity) {
  return [feels != null ? `Feels ${Number(feels).toFixed(0)}°C` : '',
    humidity != null ? `Humidity ${Number(humidity).toFixed(0)}%` : ''].filter(Boolean).join(' · ');
}

/** Weather placeholder when no provider answered: never pretends "Clear Sky". */
function unavailableWeather() {
  return { available: false, icon_class: 'fi fi-sr-cloud-question', desc: '', temp: null, extra: '', forecast_weather: [], hourly: [] };
}

// ---- Issue #127 S1-prime: selectable forecast sources ----
const SOURCE_LABELS = { solcast: 'Solcast', 'open-meteo': 'Open-Meteo', none: 'None' };

// Known Solcast forecast fields (AC3/AC3a): absent -> null, never 0.
// Unknown/future upstream fields are ALSO forwarded verbatim (never stripped);
// only the derived `cloud_cover` alias is added for backwards compat.
const SOLCAST_KNOWN_FIELDS = [
  'period', 'period_end',
  'pv_estimate', 'pv_estimate10', 'pv_estimate90',
  'ghi', 'ghi10', 'ghi90',
  'dni', 'dni10', 'dni90', 'ebh',
  'dhi', 'dhi10', 'dhi90',
  'air_temp', 'relative_humidity',
  'cloud_opacity', 'precip_rate',
  'wind_speed', 'wind_speed_10m',
  'azimuth', 'zenith'
];

// Full-schema passthrough (D3): forward every upstream field verbatim,
// fill absent known fields with null, keep derived cloud_cover alias.
// Present values (including 0) are never rewritten.
// Solcast's current names for the values the rest of the app already knows by another name. Both are kept.
const SOLCAST_ALIASES = { pv_power_rooftop: 'pv_estimate', pv_power_rooftop10: 'pv_estimate10', pv_power_rooftop90: 'pv_estimate90', precipitation_rate: 'precip_rate' };
function applySolcastAliases(out) {
  for (const [from, to] of Object.entries(SOLCAST_ALIASES)) if (out[from] != null && out[to] == null) out[to] = out[from];
  if (out.cloud_cover == null && out.cloud_opacity != null) out.cloud_cover = out.cloud_opacity;
  return out;
}
function mapSolcastPeriod(f) {
  const src = (f && typeof f === 'object') ? f : {};
  const out = {};
  for (const k of Object.keys(src)) out[k] = src[k] === undefined ? null : src[k];
  applySolcastAliases(out);
  for (const k of SOLCAST_KNOWN_FIELDS) if (!(k in out)) out[k] = null;
  if (out.cloud_cover == null) out.cloud_cover = out.cloud_opacity ?? null;
  return out;
}
/** A weather/irradiance period: the values Solcast sent, under the app's names too, with no PV fields made up. */
function mapSolcastWeatherPeriod(f) {
  const out = {};
  for (const [k, v] of Object.entries((f && typeof f === 'object') ? f : {})) out[k] = v === undefined ? null : v;
  return applySolcastAliases(out);
}

// Normalize the ?source= selector. Returns 'auto' | 'solcast' | 'open-meteo'
// | 'rest:<name>', or null for unknown selectors.
function normalizeSourceSelector(sel) {
  const raw = String(sel == null ? 'auto' : sel).trim();
  if (!raw) return 'auto';
  const s = raw.toLowerCase();
  if (s === 'auto' || s === 'solcast' || s === 'open-meteo') return s;
  if (s.startsWith('rest:')) return 'rest:' + raw.slice(5); // scheme normalized; name keeps original case (S5 lookup is case-sensitive)
  return null;
}

// D4: prefer Solcast air_temp / relative_humidity for weather when present.
// First non-null occurrence wins; missing values stay null (OM fallback).
function pickSolcastWeather(periods, nowMs) {
  let temp = null, humidity = null;
  // With the time given, the period that is current comes first: the first period of today is this morning's.
  let list = periods || [];
  if (Number.isFinite(nowMs)) {
    const cur = list.find(p => { const end = periodEndMs(p); return end != null && end > nowMs && end - periodHours(p) * 3600000 <= nowMs; });
    if (cur) list = [cur, ...list];
  }
  for (const p of list) {
    if (temp == null && p && p.air_temp != null) temp = p.air_temp;
    if (humidity == null && p && p.relative_humidity != null) humidity = p.relative_humidity;
    if (temp != null && humidity != null) break;
  }
  return { temp, humidity };
}

// Test hook (no prod callers): drop all per-selector cache entries.
function clearForecastCache() {
  solarCache = { value: 0, timestamp: 0 };
  forecastCache = {}; solcastNegativeCache = {}; solcastLastUpstreamAttempt = 0;
  solcastWeatherCache = { at: 0, byEnd: new Map(), params: 'all' }; solcastWeatherOffUntil = 0;
  openMeteoCache = { key: null, data: null, timestamp: 0 }; lastGoodWeather = null; tiltedCache.clear();
}

// ---- Issue #127 follow-up: Solcast negative-cache helpers ----

// Drop negative cache for a selector (or all if selector omitted).
function clearSolcastNegativeCache(selector) {
  if (selector) delete solcastNegativeCache[selector];
  else solcastNegativeCache = {};
}

// Check if a negative cache entry is still valid (not expired).
function isNegativeCacheValid(entry, now) {
  return entry && entry.retryAt && entry.retryAt > now;
}

// Compute negative cache TTL and retryAt based on error type.
function computeNegativeCacheEntry(errorText, status, retryAfterHeader) {
  const now = Date.now();
  let ttlMs;
  if (status === 429) {
    const retryAfterSec = parseInt(retryAfterHeader, 10);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      ttlMs = Math.min(retryAfterSec * 1000, SOLCAST_NEGATIVE_TTL_MAX_MS);
    } else {
      ttlMs = Math.min(SOLCAST_NEGATIVE_TTL_429_BASE_MS, SOLCAST_NEGATIVE_TTL_MAX_MS);
    }
  } else {
    // transport error, 5xx, empty response, or other non-OK
    ttlMs = SOLCAST_NEGATIVE_TTL_TRANSPORT_MS;
  }
  const retryAt = now + ttlMs;
  return {
    errorText,
    firstFailure: now,
    retryAt,
    lastGood: null,
    lastGoodData: null,
    cachedError: true
  };
}

// Check if we can attempt an upstream Solcast fetch (global 60-min gate).
function canAttemptSolcastUpstream() {
  const now = Date.now();
  return (now - solcastLastUpstreamAttempt) >= SOLCAST_UPSTREAM_GATE_MS;
}

// Record a Solcast upstream attempt (success or failure).
function recordSolcastUpstreamAttempt() {
  solcastLastUpstreamAttempt = Date.now();
}

// Store a successful Solcast response as lastGood in negative cache (if entry exists).
function recordSolcastSuccess(selector, data) {
  const entry = solcastNegativeCache[selector];
  if (entry) {
    entry.lastGood = Date.now();
    entry.lastGoodData = data;
  }
}

// Build the cached error response object (byte-identical error text + advisory fields).
function buildCachedErrorResponse(entry, selector) {
  return {
    error: entry.errorText,
    cached_error: true,
    first_failure: new Date(entry.firstFailure).toISOString(),
    retry_after: new Date(entry.retryAt).toISOString(),
    last_good: entry.lastGood ? new Date(entry.lastGood).toISOString() : null,
    source: selector,
    source_label: SOURCE_LABELS[selector] || selector
  };
}

// ---- Issue #127 S2: global default sources (AC9) ----
// Every config key whose save can change getSolarForecast() output.
const FORECAST_CACHE_KEYS = [
  'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
  'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
  'solar_loss_factor', 'solar_install_date', 'solar_arrays',
  'forecast_default_source', 'weather_default_source', 'solcast_daily_limit', 'solcast_weather'
];

// Resolve a global default source key to an effective selector.
// Invalid/unknown values fall back to 'auto' (never null); empty/unset is
// already 'auto' via normalizeSourceSelector.
function resolveDefaultSource(configKey) {
  const sel = normalizeSourceSelector(getConfig(configKey));
  return sel === null ? 'auto' : sel;
}

// Pure helper (no side effects): true when a settings save touched any key
// that can change getSolarForecast() output -> caller must clearForecastCache().
function shouldInvalidateForecastCache(savedKeys) {
  const keys = Array.isArray(savedKeys) ? savedKeys : Object.keys(savedKeys || {});
  return keys.some((k) => FORECAST_CACHE_KEYS.includes(k));
}

// ---- Issue #127 S5-backend: rest: resolver ----
// Block rest_map is per-card config (not available backend-side), so the
// resolver takes an optional restMap seam: { temp, humidity, wind, precip,
// cloud, ghi, description, pv_estimate } of latest_metrics metric names
// (non-string values ignored). Without a map, identity aliases apply.
const REST_DEFAULT_ALIASES = {
  temp: ['temp', 'air_temp', 'temperature'],
  humidity: ['humidity', 'relative_humidity'],
  wind: ['wind', 'wind_speed'],
  precip: ['precip', 'precip_rate'],
  cloud: ['cloud', 'cloud_cover'],
  ghi: ['ghi', 'shortwave_radiation'],
  description: ['description', 'weather_desc'],
  pv_estimate: ['pv_estimate']
};

// Resolve a rest:<name> source to point values from latest_metrics.
// Returns { error } for unknown/disabled/missing-url sources, else a
// forecast-shaped result with 3 all-null daily stubs and empty hourly.
function resolveRestSource(name, restMap) {
  const trimmed = String(name == null ? '' : name).trim();
  const key = 'rest:' + trimmed;
  let sources = [];
  try { sources = JSON.parse(getConfig('external_sources') || '[]'); } catch (e) { sources = []; }
  if (!Array.isArray(sources)) sources = [];
  const src = sources.find((s) => s && s.name === trimmed);
  if (!src || !src.enabled || !src.url) return { error: `Source unavailable: ${key}` };

  const map = (restMap && typeof restMap === 'object' && !Array.isArray(restMap)) ? restMap : {};
  let rows = [];
  try {
    flushMetrics();
    rows = getDb().prepare('SELECT metric, value, value_text FROM latest_metrics').all();
  } catch (e) { rows = []; }
  const byMetric = new Map();
  for (const r of rows || []) if (r && r.metric != null && !byMetric.has(r.metric)) byMetric.set(r.metric, r);
  const numVal = (row) => {
    if (!row) return null;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : null;
  };
  const lookup = (field) => {
    const mapped = map[field];
    if (typeof mapped === 'string' && mapped) return byMetric.get(mapped) || null;
    const aliases = REST_DEFAULT_ALIASES[field] || [];
    for (const a of aliases) if (byMetric.has(a)) return byMetric.get(a);
    return null;
  };

  const temp = numVal(lookup('temp'));
  const humidity = numVal(lookup('humidity'));
  const wind = numVal(lookup('wind'));
  const precip = numVal(lookup('precip'));
  const cloud = numVal(lookup('cloud'));
  const ghi = numVal(lookup('ghi'));
  const pv = numVal(lookup('pv_estimate'));
  const descRow = lookup('description');
  const description = descRow ? (descRow.value_text != null ? descRow.value_text : descRow.value) : null;

  const daily = [0, 1, 2].map((off) => {
    const d = new Date();
    d.setDate(d.getDate() + off);
    return { date: d.toLocaleDateString('en-CA'), total_kwh: null, peak_kw: null, source: key };
  });

  const weather = {
    temp, humidity, wind, precip, cloud, ghi,
    feels_like: null, icon: null, description,
    // Compat with the Open-Meteo weather shape the dashboard consumes.
    icon_class: null, desc: description, extra: '', forecast_weather: []
  };

  return {
    source: key,
    source_label: src.name,
    weather_source: key,
    weather, daily, hourly: [],
    server_today: localDateString(),
    pv_estimate: pv
  };
}


// ---- A day's weather from the forecast periods (Solcast supplies it per period) ----
const numOf = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
/** Fold one period's weather into its day's running totals (kept on the day as `wx`, removed by finishDayWeather). */
function accumulateDayWeather(day, f) {
  const wx = day.wx || (day.wx = { tmin: null, tmax: null, precip: null, wind: null, gust: null, cloud: 0, cloudN: 0, ghi: null, snow: null });
  const h = periodHours(f);
  const t = numOf(f.air_temp), tmin = numOf(f.min_air_temp), tmax = numOf(f.max_air_temp);
  for (const v of [t, tmin]) if (v != null) wx.tmin = wx.tmin == null ? v : Math.min(wx.tmin, v);
  for (const v of [t, tmax]) if (v != null) wx.tmax = wx.tmax == null ? v : Math.max(wx.tmax, v);
  const pr = numOf(f.precip_rate ?? f.precipitation_rate); if (pr != null) wx.precip = (wx.precip || 0) + pr * h;
  const ws = numOf(f.wind_speed_10m); if (ws != null) wx.wind = wx.wind == null ? ws : Math.max(wx.wind, ws);
  const wg = numOf(f.wind_gust); if (wg != null) wx.gust = wx.gust == null ? wg : Math.max(wx.gust, wg);
  const cc = numOf(f.cloud_opacity); if (cc != null) { wx.cloud += cc; wx.cloudN++; }
  const g = numOf(f.ghi); if (g != null) wx.ghi = (wx.ghi || 0) + g * h / 1000;
  const sn = numOf(f.snowfall_rate); if (sn != null) wx.snow = (wx.snow || 0) + sn * h;
}
/** Turn a day's running totals into its fields (only the ones the forecast supplied) and drop the working data. */
function finishDayWeather(day) {
  const wx = day.wx; delete day.wx;
  if (!wx) return;
  const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
  if (wx.tmin != null) day.temp_min = r1(wx.tmin);
  if (wx.tmax != null) day.temp_max = r1(wx.tmax);
  if (wx.precip != null) day.precip_mm = r1(wx.precip);
  if (wx.wind != null) day.wind_max = r1(wx.wind);
  if (wx.gust != null) day.wind_gust_max = r1(wx.gust);
  if (wx.cloudN) day.cloud_cover_avg = Math.round(wx.cloud / wx.cloudN);
  if (wx.ghi != null) day.ghi_kwh_m2 = r2(wx.ghi);
  if (wx.snow != null) day.snowfall_cm = r1(wx.snow);
}


/** The forecast period that is current at `nowMs` (its end is ahead, its start is not), or null. */
function currentPeriod(periods, nowMs = Date.now()) {
  return (periods || []).find(p => { const end = periodEndMs(p); return end != null && end > nowMs && end - periodHours(p) * 3600000 <= nowMs; }) || null;
}

/**
 * What the current Solcast period says about the weather, in the shapes the weather card uses:
 * `overrides` replace the card's point values (same units as Open-Meteo's: °C, %, m/s, hPa, mm, W/m²), `details` are the
 * extra values the card can list. Both hold only what Solcast actually sent.
 */
function solcastWeatherView(cur) {
  if (!cur) return { overrides: {}, details: {} };
  const n = k => numOf(cur[k]);
  const put = (obj, k, v) => { if (v != null) obj[k] = v; };
  const overrides = {};
  put(overrides, 'temp', n('air_temp')); put(overrides, 'humidity', n('relative_humidity'));
  put(overrides, 'wind_speed', n('wind_speed_10m')); put(overrides, 'wind_gusts', n('wind_gust'));
  const dir = n('wind_direction_10m'); if (dir != null) { overrides.wind_direction = dir; overrides.wind_compass = compassPoint(dir); }
  put(overrides, 'cloud_cover', n('cloud_opacity')); put(overrides, 'precip', n('precip_rate') ?? n('precipitation_rate'));
  put(overrides, 'pressure', n('surface_pressure')); put(overrides, 'ghi', n('ghi'));
  const details = {};
  for (const k of ['dewpoint_temp', 'dni', 'dhi', 'gti', 'clearsky_ghi', 'albedo', 'zenith', 'wind_speed_100m', 'snow_depth', 'snowfall_rate', 'snow_water_equivalent', 'snow_soiling_rooftop', 'snow_soiling_ground', 'precipitable_water', 'cape', 'pm10', 'pm2.5']) put(details, k.replace('.', '_'), n(k));
  return { overrides, details };
}

// ---- Solcast weather and irradiance (every forecast parameter Solcast offers) ----
// One extra request per refresh, to /data/forecast/radiation_and_weather, merged into the PV periods by period_end.
// It is optional: when it fails (the plan does not include it, the quota is used up) the PV forecast is untouched,
// and what was last fetched stays merged. Requests are counted against the daily limit (solcastBudgetAllows).
let solcastWeatherCache = { at: 0, byEnd: new Map(), params: 'all' };
let solcastWeatherOffUntil = 0;   // epoch ms: not tried again before this (plan lacks it, or the quota is used up)

function nextUtcMidnight(ms) { return Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1); }

/** Copy each fetched weather period's values onto the PV period with the same end (PV values are never replaced). */
function mergeSolcastWeather(periods, byEnd) {
  if (!Array.isArray(periods) || !(byEnd instanceof Map) || !byEnd.size) return periods;
  for (const p of periods) {
    const w = byEnd.get(periodEndMs(p));
    if (!w) continue;
    for (const [k, v] of Object.entries(w)) {
      if (k === 'period' || k === 'period_end' || v == null) continue;
      if (p[k] == null) p[k] = v;
    }
  }
  return periods;
}

async function refreshSolcastWeather(site, apiKey, now) {
  const c = solcastWeatherCache;
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = c.params === 'core' ? SOLCAST_WEATHER_CORE : SOLCAST_WEATHER_PARAMS;
    let res;
    try { res = await solcastFetch(solcastWeatherUrl(site, list), apiKey); databaseWork.assertCurrent(); }
    catch (e) { databaseWork.assertCurrent(); solcastWeatherOffUntil = now + 30 * 60000; logger.warn(`[forecast] Solcast weather unavailable: ${e.message}`); return; }
    if (res.ok) {
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      databaseWork.assertCurrent();
      const byEnd = new Map();
      for (const f of (data && Array.isArray(data.forecasts) ? data.forecasts : [])) {
        const w = mapSolcastWeatherPeriod(f), ms = periodEndMs(w);
        if (ms != null) byEnd.set(ms, w);
      }
      if (byEnd.size) { solcastWeatherCache = { at: now, byEnd, params: c.params }; solcastWeatherOffUntil = 0; }
      else { solcastWeatherOffUntil = now + 30 * 60000; logger.warn('[forecast] Solcast weather returned no periods'); }
      return;
    }
    let body = ''; try { body = (await res.text()).slice(0, 200); } catch (_) { /* no body */ }
    databaseWork.assertCurrent();
    if (res.status === 400 && c.params !== 'core') {
      // One of the parameters is not accepted: carry on with the well-established ones, and remember it.
      logger.warn(`[forecast] Solcast weather rejected the full parameter list (${body || 'HTTP 400'}); using the core set`);
      c.params = 'core';
      continue;
    }
    if (res.status === 401 || res.status === 403) { solcastWeatherOffUntil = now + 24 * 3600000; logger.warn(`[forecast] Solcast weather is not available for this key (HTTP ${res.status}); trying again tomorrow`); }
    else if (res.status === 402 || res.status === 429) {
      const retry = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      solcastWeatherOffUntil = Number.isFinite(retry) && retry > 0 ? now + Math.min(retry * 1000, 6 * 3600000) : nextUtcMidnight(now);
      logger.warn(`[forecast] Solcast weather: request limit reached (HTTP ${res.status})`);
    } else { solcastWeatherOffUntil = now + 30 * 60000; logger.warn(`[forecast] Solcast weather HTTP ${res.status}`); }
    return;
  }
}

/** Fetch (when due and affordable) and merge Solcast's weather and irradiance into the PV periods. */
async function attachSolcastWeatherData(periods, site, apiKey, pvJobs, now = Date.now()) {
  if (getConfig('solcast_weather') === 'false' || !(site.latitude && site.longitude)) return;
  const due = now - solcastWeatherCache.at >= FORECAST_CACHE_MS && now >= solcastWeatherOffUntil && solcastBudgetAllows(pvJobs, now);
  if (due) await refreshSolcastWeather(site, apiKey, now);
  mergeSolcastWeather(periods, solcastWeatherCache.byEnd);
}

// What each Solcast value is measured in, for the metrics below.
const SOLCAST_METRIC_UNITS = {
  pv_estimate: 'kW', pv_estimate10: 'kW', pv_estimate90: 'kW',
  air_temp: '°C', min_air_temp: '°C', max_air_temp: '°C', dewpoint_temp: '°C', relative_humidity: '%',
  ghi: 'W/m²', ghi10: 'W/m²', ghi90: 'W/m²', dni: 'W/m²', dni10: 'W/m²', dni90: 'W/m²', dhi: 'W/m²', dhi10: 'W/m²', dhi90: 'W/m²',
  gti: 'W/m²', gti10: 'W/m²', gti90: 'W/m²', clearsky_ghi: 'W/m²', clearsky_dni: 'W/m²', clearsky_dhi: 'W/m²', clearsky_gti: 'W/m²',
  cloud_opacity: '%', cloud_opacity10: '%', cloud_opacity90: '%', albedo: '', azimuth: '°', zenith: '°',
  wind_speed_10m: 'm/s', wind_speed_100m: 'm/s', wind_direction_10m: '°', wind_direction_100m: '°', wind_gust: 'm/s',
  precipitation_rate: 'mm/h', snowfall_rate: 'cm/h', snow_depth: 'cm', snow_water_equivalent: 'cm', snow_soiling_rooftop: '%', snow_soiling_ground: '%',
  surface_pressure: 'hPa', precipitable_water: 'kg/m²', cape: 'J/kg', pm10: 'µg/m³', 'pm2.5': 'µg/m³'
};
let lastSolcastMetricsAt = 0;

/**
 * Publish the values of the forecast period that is current now as metrics named solcast_<value>, so any card,
 * chart, notification or combined metric can use them. At most once a minute.
 */
function publishSolcastMetrics(periods, now = Date.now()) {
  if (!Array.isArray(periods) || now - lastSolcastMetricsAt < 60000) return 0;
  const cur = currentPeriod(periods, now);
  if (!cur) return 0;
  lastSolcastMetricsAt = now;
  const ts = Math.floor(now / 1000);
  let n = 0;
  try {
    for (const [field, unit] of Object.entries(SOLCAST_METRIC_UNITS)) {
      const v = cur[field] == null ? NaN : Number(cur[field]);
      if (!Number.isFinite(v)) continue;
      queueMetricValue(`solcast_${field.replace(/\./g, '_')}`, v, ts, unit);
      n++;
    }
  } catch (e) { logger.debug(`[forecast] could not publish Solcast metrics: ${e.message}`); }   // never breaks the forecast
  return n;
}

async function getSolarForecast(sourceParam, restMap) {
  const forecastEnabled = getConfig('forecast_enabled') === 'true';
  if (!forecastEnabled) return { error: 'Forecast disabled' };

  const selector = normalizeSourceSelector(sourceParam);
  if (selector === null) return { error: `Unknown forecast source: ${sourceParam}` };
  if (selector.startsWith('rest:')) return resolveRestSource(selector.slice(5), restMap);

  const now = Date.now();
  const cached = forecastCache[selector];
  if (cached && cached.data && (now - cached.timestamp) < FORECAST_CACHE_MS) {
    // The PV forecast curve is kept for 3 h (Solcast quota), but
    // `actual_so_far` is live telemetry (computeTodaySolar(), itself only
    // 30s-cached) -- it must never be frozen for the full forecast TTL, or
    // "produced" on the card goes stale for up to 3h. Refresh it on every
    // cache hit, same as weather.
    if (cached.data.daily[0]?.date !== localDateString()) {
      delete forecastCache[selector];
    } else {
      const todayDate = localDateString();
      cached.data.server_today = todayDate;
      const actualTodayKwh = computeTodaySolar();
      for (const dayEntry of cached.data.daily) {
        if (dayEntry.date === todayDate) dayEntry.actual_so_far = actualTodayKwh;
      }
      await attachWeather(cached.data, cached.ctx);
      if (cached.data.source === 'solcast') publishSolcastMetrics(cached.data.hourly);
      return cached.data;
    }
  }

  const lat = parseFloat(getConfig('solar_latitude')) || null;
  const lon = parseFloat(getConfig('solar_longitude')) || null;
  const arrays = getArrays();
  const capacityKwp = arrays.reduce((sum, a) => sum + a.kwp, 0);
  const solcastKey = getConfig('solcast_api_key');
  const resourceId = getConfig('solcast_resource_id');
  const lossFactor = parseFloat(getConfig('solar_loss_factor')) || 0.9;
  const installDate = getConfig('solar_install_date') || '2020-01-01';
  if (capacityKwp <= 0) return { error: 'System capacity not configured' };

  let forecastData = null, source = 'none';

  // D2: auto keeps the Solcast -> Open-Meteo cascade; an explicit pick
  // uses that path ONLY and hard-errors on failure (no silent cascade).
  // S2 (AC9): a requesting selector of 'auto' resolves through the global
  // forecast default: global auto -> cascade; global solcast/open-meteo ->
  // that path only with the same hard-error semantics as an explicit pick.
  // An invalid global falls back to 'auto' (cascade). rest: globals are
  // rejected like explicit rest: picks (S5 owns them).
  const forecastSel = selector === 'auto' ? resolveDefaultSource('forecast_default_source') : selector;
  if (forecastSel.startsWith('rest:')) return resolveRestSource(forecastSel.slice(5), restMap);
  const wantSolcast = forecastSel === 'auto' || forecastSel === 'solcast';
  const wantOpenMeteo = forecastSel === 'auto' || forecastSel === 'open-meteo';

  if (wantSolcast && solcastKey) {
    // --- Negative-cache check (per selector) ---
    const negEntry = solcastNegativeCache[forecastSel];
    if (isNegativeCacheValid(negEntry, now)) {
      if (forecastSel === 'solcast') return buildCachedErrorResponse(negEntry, forecastSel);
      // auto: skip Solcast fetch, fall through to OM cascade (no record)
    } else {
      // --- Upstream gate (global 60-min) ---
      if (!canAttemptSolcastUpstream()) {
        // Gate closed -> treat as negative-cached
        const gateEntry = negEntry || { errorText: 'Upstream gate: Solcast rate limited', firstFailure: now, retryAt: now + SOLCAST_UPSTREAM_GATE_MS, cachedError: true };
        if (forecastSel === 'solcast') return buildCachedErrorResponse(gateEntry, forecastSel);
        // auto: skip Solcast fetch, fall through to OM cascade
      } else {
        recordSolcastUpstreamAttempt();
        let solcastErrText = null, solcastErrStatus = null, solcastRetryAfter = null;

        // One site-wide resource ID covers the whole site (Solcast sites can hold
        // several arrays). Otherwise each array is fetched on its own (its own
        // rooftop resource, or the world PV API with its size and direction) and
        // the forecasts are added up. Any array failing fails the lot, so a
        // partial total is never shown as the whole site.
        const perArray = !resourceId && (arrays.length > 1 || arrays.some(a => a.solcast_resource_id));
        const jobs = !perArray
          ? [resourceId ? { url: solcastRooftopUrl(resourceId), what: 'rooftop' } : (lat && lon ? { url: solcastPvUrl({ latitude: lat, longitude: lon, capacity: capacityKwp, tilt: arrays[0].tilt, azimuth: arrays[0].azimuth, loss_factor: lossFactor, install_date: installDate }), what: 'world PV' } : null)]
          : arrays.map(a => (a.solcast_resource_id ? { url: solcastRooftopUrl(a.solcast_resource_id), what: `rooftop (${a.name})` }
            : (lat && lon ? { url: solcastPvUrl({ latitude: lat, longitude: lon, capacity: a.kwp, tilt: a.tilt, azimuth: a.azimuth, loss_factor: lossFactor, install_date: installDate }), what: `world PV (${a.name})` } : null)));
        const results = [];
        for (const job of jobs) {
          if (!job) { solcastErrText = 'Solcast needs a location or a resource ID'; break; }
          try {
            const res = await solcastFetch(job.url, solcastKey);
            databaseWork.assertCurrent();
            if (!res.ok) { solcastErrStatus = res.status; solcastRetryAfter = res.headers.get('retry-after'); solcastErrText = `Solcast ${job.what} HTTP ${res.status}`; break; }
            const data = await res.json(); databaseWork.assertCurrent();
            if (!data.forecasts) { solcastErrText = `Solcast ${job.what}: no forecast`; break; }
            results.push(data.forecasts.map(mapSolcastPeriod));
          } catch (e) { databaseWork.assertCurrent(); solcastErrText = `Solcast ${job.what} error: ${e.message}`; break; }
        }
        if (results.length === jobs.length && results.length) { forecastData = results.length === 1 ? results[0] : sumForecastPeriods(results); source = 'solcast'; }
        // A site-wide rooftop that fails still falls back to the world PV API.
        if (!forecastData && !perArray && resourceId && lat && lon) {
          try {
            const res = await solcastFetch(solcastPvUrl({ latitude: lat, longitude: lon, capacity: capacityKwp, tilt: arrays[0].tilt, azimuth: arrays[0].azimuth, loss_factor: lossFactor, install_date: installDate }), solcastKey);
            databaseWork.assertCurrent();
            if (res.ok) { const data = await res.json(); databaseWork.assertCurrent(); if (data.forecasts) { forecastData = data.forecasts.map(mapSolcastPeriod); source = 'solcast'; } }
            else { solcastErrStatus = res.status; solcastRetryAfter = res.headers.get('retry-after'); solcastErrText = `Solcast world PV HTTP ${res.status}`; }
          } catch (e) { databaseWork.assertCurrent(); solcastErrText = `Solcast world PV error: ${e.message}`; }
        }

        // --- On failure: populate negative cache (preserve lastGood/lastGoodData) ---
        if (!forecastData) {
          const prior = solcastNegativeCache[forecastSel];
          const entry = computeNegativeCacheEntry(solcastErrText || 'Solcast unavailable', solcastErrStatus, solcastRetryAfter);
          if (prior && prior.lastGood) { entry.lastGood = prior.lastGood; entry.lastGoodData = prior.lastGoodData; }
          solcastNegativeCache[forecastSel] = entry;
          require('./notifications/events').emitEvent('forecast.unavailable', {
            subject: 'solcast',
            message: `Solcast forecast failed: ${solcastErrText || 'unavailable'}${solcastErrStatus === 429 ? ' (the daily API quota is used up)' : ''}.`,
            data: { status: solcastErrStatus || null },
          });
        } else {
          // --- On success: clear negative cache for this selector ---
          delete solcastNegativeCache[forecastSel];
        }
      }
    }
  }

  if (forecastData && source === 'solcast') {
    // The weather and irradiance Solcast offers, with the PV forecast. One extra request, kept inside the daily budget.
    const pvJobs = resourceId ? 1 : (arrays.length > 1 || arrays.some(a => a.solcast_resource_id) ? arrays.length : 1);
    await attachSolcastWeatherData(forecastData, { latitude: lat, longitude: lon, tilt: arrays[0].tilt, azimuth: arrays[0].azimuth }, solcastKey, pvJobs, now);
  }

  if (!forecastData && forecastSel === 'solcast') return { error: 'Solcast unavailable' };

  if (!forecastData && wantOpenMeteo) {
    if (!lat || !lon) return { error: 'Location required for Open-Meteo' };
    try {
      const openMeteo = await getOpenMeteoArrays(lat, lon, arrays, lossFactor);
      forecastData = openMeteo.forecasts;
      source = openMeteo.source;
    } catch (e) {
      databaseWork.assertCurrent();
      require('./notifications/events').emitEvent('forecast.unavailable', { subject: 'open-meteo', message: `Open-Meteo forecast failed: ${e.message}.` });
      return { error: 'All forecast sources unavailable' };
    }
  }

  if (!forecastData) return { error: 'All forecast sources unavailable' };
  forecastData = withTodaysEarlierPeriods(source, forecastData);

  const actualTodayKwh = computeTodaySolar();
  const dailyMap = new Map();
  forecastData.forEach(f => {
    // Bucket by LOCAL day (period_end is a UTC instant) so "today" matches
    // the cache check and the actual_so_far lookup below.
    const end = new Date(f.period_end);
    const date = isNaN(end.getTime()) ? String(f.period_end || '').split('T')[0] : localDateString(end);
    const existing = dailyMap.get(date) || { date, total_kwh: 0, peak_kw: 0, source };
    const n = Number(f.pv_estimate);
    const pv = Number.isFinite(n) ? n : 0; // AC3a: null/absent -> 0 in sums, never NaN
    // pv_estimate is mean kW over the period: energy = kW x period length
    // (Solcast periods are 30 min, Open-Meteo 60 min).
    f.energy_kwh = pv * periodHours(f);
    existing.total_kwh += f.energy_kwh;
    existing.peak_kw = Math.max(existing.peak_kw, pv);
    accumulateDayWeather(existing, f);
    dailyMap.set(date, existing);
  });
  for (const d of dailyMap.values()) finishDayWeather(d);
  const daily = Array.from(dailyMap.values()).slice(0, 7);
  const todayDate = localDateString();
  for (const dayEntry of daily) {
    dayEntry.total_kwh = Math.round(dayEntry.total_kwh * 100) / 100;
    if (dayEntry.date === todayDate) dayEntry.actual_so_far = actualTodayKwh;
  }

  // All of today's periods (including the earlier ones) plus the next 48 h.
  const earlierCount = forecastData.filter(f => f.earlier).length;
  const hourly = forecastData.slice(0, 96 + earlierCount);
  for (const period of hourly) {
    const end = new Date(period.period_end);
    period.date = Number.isFinite(end.getTime()) ? localDateString(end) : null;
  }
  const result = { daily, hourly, source, source_label: SOURCE_LABELS[source] || source, server_today: todayDate };

  // D4: effective source is Solcast and its payload carries air_temp /
  // relative_humidity -> prefer them for weather temp/humidity.
  const ctx = {
    lat, lon, restMap,
    solcastWx: source === 'solcast' ? pickSolcastWeather(forecastData, Date.now()) : { temp: null, humidity: null }
  };
  await attachWeather(result, ctx);

  databaseWork.assertCurrent();
  forecastCache[selector] = { data: result, timestamp: now, ctx };
  if (source === 'solcast') publishSolcastMetrics(result.hourly);
  return result;
}


/**
 * (Re)build result.weather + result.weather_source in place. Open-Meteo is
 * cached for 15 min, so a cached PV forecast still shows current weather.
 * S2 (AC9) global weather default: 'auto' prefers Solcast temp/humidity when
 * this forecast carried them, 'open-meteo' ignores them, 'solcast' uses them
 * when present; rest:<name> replaces the point values from latest_metrics.
 */
async function attachWeather(result, ctx) {
  const { lat, lon, restMap, solcastWx } = ctx || {};
  const weatherSelRaw = resolveDefaultSource('weather_default_source');
  let restWeather = null;
  if (weatherSelRaw.startsWith('rest:')) {
    const resolved = resolveRestSource(weatherSelRaw.slice(5), restMap);
    if (!resolved.error) restWeather = resolved;
  }
  const weatherSel = restWeather ? weatherSelRaw : (weatherSelRaw.startsWith('rest:') ? 'auto' : weatherSelRaw);
  const useSolcastWx = weatherSel !== 'open-meteo';

  let weather = null;
  let weatherSource = 'open-meteo';
  if (lat && lon) {
    try {
      const om = await fetchOpenMeteo(lat, lon);
      weather = buildOpenMeteoWeather(om);
      databaseWork.assertCurrent();
      lastGoodWeather = weather;
      fillPeriodWeather(result.hourly, om.hourly);
    } catch (e) {
      databaseWork.assertCurrent();
      logger.warn(`[forecast] Open-Meteo weather unavailable: ${e.message}`);
      if (lastGoodWeather) weather = { ...lastGoodWeather, stale: true };
    }
  }
  if (!weather) weather = unavailableWeather();

  if (useSolcastWx && solcastWx && (solcastWx.temp != null || solcastWx.humidity != null)) {
    weather = { ...weather };
    if (solcastWx.temp != null) weather.temp = solcastWx.temp;
    if (solcastWx.humidity != null) weather.humidity = solcastWx.humidity;
    weather.extra = buildWeatherExtra(weather.feels_like, weather.humidity);
    weatherSource = 'solcast';
  }
  // S5-backend: rest: weather default wins over OM/solcast point values,
  // keeping Open-Meteo's multi-day outlook when it is available.
  if (restWeather) {
    const rw = restWeather.weather;
    weather = {
      ...weather, ...Object.fromEntries(Object.entries(rw).filter(([k, v]) => v != null && !(Array.isArray(v) && !v.length) && v !== '')),
      forecast_weather: weather.forecast_weather || [], hourly: weather.hourly || []
    };
    if (rw.wind != null) weather.wind_speed = rw.wind;
    if (rw.cloud != null) weather.cloud_cover = rw.cloud;
    if (rw.precip != null) weather.precip = rw.precip;
    weather.extra = buildWeatherExtra(weather.feels_like, weather.humidity);
    weather.available = true;
    weatherSource = restWeather.weather_source;
  }
  // Everything else Solcast sent for the current period: it replaces the point values and adds detail rows.
  if (useSolcastWx && result.source === 'solcast') {
    const { overrides, details } = solcastWeatherView(currentPeriod(result.hourly));
    if (Object.keys(overrides).length || Object.keys(details).length) {
      weather = { ...weather, ...overrides };
      if (Object.keys(details).length) weather.solcast = details;
      if (Object.keys(overrides).length) { weather.extra = buildWeatherExtra(weather.feels_like, weather.humidity); weatherSource = 'solcast'; }
    }
  }
  result.weather = weather;
  // S2 (AC9, additive): which provider supplied the weather temp/humidity.
  result.weather_source = weatherSource;
}

async function testForecast(opts) {
  // Accept values directly (from form) or fall back to DB config
  const lat = parseFloat(opts?.lat ?? getConfig('solar_latitude'));
  const lon = parseFloat(opts?.lon ?? getConfig('solar_longitude'));
  let formArrays = opts?.arrays;
  if (typeof formArrays === 'string') { try { formArrays = JSON.parse(formArrays); } catch (_) { formArrays = undefined; } }
  const arrays = getArrays(Array.isArray(formArrays) && formArrays.length ? { arrays: formArrays } : (opts?.capacity != null && opts.capacity !== '' ? { capacity: opts.capacity, tilt: parseFloat(opts.tilt) || 30, azimuth: parseFloat(opts.azimuth) || 180 } : {}));
  const capacityKwp = arrays.reduce((sum, a) => sum + a.kwp, 0);
  if (isNaN(lat) || isNaN(lon) || !(capacityKwp > 0)) throw new Error('Invalid location or capacity');
  const solcastKey = opts?.api_key ?? getConfig('solcast_api_key');
  const resourceId = opts?.resource_id ?? getConfig('solcast_resource_id');
  const lossFactor = parseFloat(opts?.loss ?? getConfig('solar_loss_factor')) || 0.9;
  const installDate = (opts?.install_date ?? getConfig('solar_install_date')) || '2020-01-01';
  const today = localDateString();
  // kWh today and the peak kW from forecast periods (periods can be 30 or 60 minutes).
  const summarise = list => list.reduce((acc, f) => {
    if (localDateString(new Date(f.period_end)) !== today) return acc;
    acc.kwh += (Number(f.pv_estimate) || 0) * periodHours(f); acc.peak = Math.max(acc.peak, Number(f.pv_estimate) || 0); return acc;
  }, { kwh: 0, peak: 0 });
  let source = 'none', result = { kwh: 0, peak: 0 };

  if (solcastKey) {
    const perArray = !resourceId && (arrays.length > 1 || arrays.some(a => a.solcast_resource_id));
    const urls = !perArray
      ? [resourceId ? solcastRooftopUrl(resourceId) : solcastPvUrl({ latitude: lat, longitude: lon, capacity: capacityKwp, tilt: arrays[0].tilt, azimuth: arrays[0].azimuth, loss_factor: lossFactor, install_date: installDate })]
      : arrays.map(a => (a.solcast_resource_id ? solcastRooftopUrl(a.solcast_resource_id) : solcastPvUrl({ latitude: lat, longitude: lon, capacity: a.kwp, tilt: a.tilt, azimuth: a.azimuth, loss_factor: lossFactor, install_date: installDate })));
    try {
      const lists = [];
      for (const url of urls) {
        const res = await solcastFetch(url, solcastKey);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        lists.push(((await res.json()).forecasts || []).map(mapSolcastPeriod));
      }
      result = summarise(lists.length === 1 ? lists[0] : sumForecastPeriods(lists));
      source = 'solcast';
    } catch (e) { logger.debug(`Solcast test unavailable: ${e.message}`); }
  }
  if (source === 'none') {
    try {
      const om = await getOpenMeteoArrays(lat, lon, arrays, lossFactor);
      result = summarise(om.forecasts);
      source = 'open-meteo';
    } catch (e) { throw new Error('Forecast service unavailable'); }
  }
  return { source, arrays: arrays.length, capacity_kwp: +capacityKwp.toFixed(2), today_estimate_kwh: result.kwh.toFixed(2), peak_kw: result.peak.toFixed(2) };
}

module.exports = { solcastPvUrl, solcastWeatherUrl, solcastRooftopUrl, mapSolcastWeatherPeriod, mergeSolcastWeather, attachSolcastWeatherData, publishSolcastMetrics, solcastBudgetAllows, solcastRequestsToday, solcastDailyLimit, accumulateDayWeather, finishDayWeather, SOLCAST_WEATHER_PARAMS, SOLCAST_WEATHER_CORE, SOLCAST_METRIC_UNITS, SOLCAST_FORMAT, resetSolcastWeather: () => { solcastWeatherCache = { at: 0, byEnd: new Map(), params: 'all' }; solcastWeatherOffUntil = 0; lastSolcastMetricsAt = 0; }, getArrays, openMeteoAzimuth, sumForecastPeriods, getOpenMeteoArrays, withTodaysEarlierPeriods, fillPeriodWeather, computeSolarForDate, computeTodaySolar, getSolarForecast, testForecast, weatherCodeMap, DEFAULT_WEATHER, describeWeatherCode, parseOpenMeteo, buildOpenMeteoWeather, periodHours, compassPoint, mapSolcastPeriod, normalizeSourceSelector, pickSolcastWeather, clearForecastCache, resolveDefaultSource, shouldInvalidateForecastCache, FORECAST_CACHE_KEYS, resolveRestSource, REST_DEFAULT_ALIASES, solcastNegativeCache, solcastLastUpstreamAttempt, SOLCAST_UPSTREAM_GATE_MS, SOLCAST_NEGATIVE_TTL_TRANSPORT_MS, SOLCAST_NEGATIVE_TTL_429_BASE_MS, SOLCAST_NEGATIVE_TTL_MAX_MS, clearSolcastNegativeCache, isNegativeCacheValid, computeNegativeCacheEntry, canAttemptSolcastUpstream, recordSolcastUpstreamAttempt, recordSolcastSuccess, buildCachedErrorResponse };
