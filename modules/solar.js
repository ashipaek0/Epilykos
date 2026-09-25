const { logger } = require('./logger');
const https = require('https');
const { getConfig, getDb, flushMetrics } = require('./database');
const { localDateString } = require('./localTime');

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

function computeSolarForDate(dateStr) {
  const db = getDb();
  const startOfDay = new Date(dateStr + 'T00:00:00');
  const endOfDay = new Date(dateStr + 'T23:59:59');
  const startUnix = Math.floor(startOfDay.getTime() / 1000);
  const endUnix = Math.floor(endOfDay.getTime() / 1000);
  const rows = db.prepare('SELECT timestamp, solar FROM history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);
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
    const ds = db.prepare('SELECT MAX(daily_solar) as max_kwh FROM history WHERE timestamp >= ? AND timestamp <= ?').get(startUnix, endUnix);
    if (ds && ds.max_kwh && ds.max_kwh > 0) totalKwh = ds.max_kwh;
  }
  return totalKwh;
}

function computeTodaySolar() {
  const db = getDb();
  const nowMs = Date.now();
  // Cache hit within 30s TTL (only if we have a real value)
  if (solarCache.value > 0 && (nowMs - solarCache.timestamp) < SOLAR_CACHE_MS) {
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
      const rows = db.prepare(
        'SELECT timestamp, value FROM metrics WHERE metric = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
      ).all(configured, startUnix, endUnix);
      if (rows.length >= 2) { computed = integrateWattsToKwh(rows, endUnix); done = true; }
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
          const rows = db.prepare(
            'SELECT timestamp, value FROM metrics WHERE metric = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
          ).all(allMetrics[i].metric, startUnix, endUnix);
          if (rows.length >= 2) { computed = integrateWattsToKwh(rows, endUnix); done = true; break; }
        }
      }
    }
  }

  // 4. Fall back to history table (HA/MQTT legacy path)
  if (!done) {
    const histRows = db.prepare(
      'SELECT timestamp, solar as value FROM history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
    ).all(startUnix, endUnix);
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
function mapSolcastPeriod(f) {
  const src = (f && typeof f === 'object') ? f : {};
  const out = {};
  for (const k of Object.keys(src)) out[k] = src[k] === undefined ? null : src[k];
  for (const k of SOLCAST_KNOWN_FIELDS) if (!(k in out)) out[k] = null;
  if (out.cloud_cover == null) out.cloud_cover = out.cloud_opacity ?? null;
  return out;
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
function pickSolcastWeather(periods) {
  let temp = null, humidity = null;
  for (const p of periods || []) {
    if (temp == null && p && p.air_temp != null) temp = p.air_temp;
    if (humidity == null && p && p.relative_humidity != null) humidity = p.relative_humidity;
    if (temp != null && humidity != null) break;
  }
  return { temp, humidity };
}

// Test hook (no prod callers): drop all per-selector cache entries.
function clearForecastCache() {
  forecastCache = {}; solcastNegativeCache = {}; solcastLastUpstreamAttempt = 0;
  openMeteoCache = { key: null, data: null, timestamp: 0 }; lastGoodWeather = null;
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
  'solar_loss_factor', 'solar_install_date',
  'forecast_default_source', 'weather_default_source'
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
    pv_estimate: pv
  };
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
    // The PV forecast is kept for 3 h (Solcast quota), but the day it starts
    // on must still be today; weather is refreshed on its own 15-min cadence.
    if (cached.data.daily[0]?.date !== localDateString()) {
      delete forecastCache[selector];
    } else {
      await attachWeather(cached.data, cached.ctx);
      return cached.data;
    }
  }

  const lat = parseFloat(getConfig('solar_latitude')) || null;
  const lon = parseFloat(getConfig('solar_longitude')) || null;
  const capacityKwp = parseFloat(getConfig('solar_capacity_kwp')) || 0;
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

        if (resourceId) {
          try {
            const url = `https://api.solcast.com.au/rooftop_sites/${resourceId}/forecasts?format=json&api_key=${solcastKey}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (res.ok) {
              const data = await res.json();
              if (data.forecasts) { forecastData = data.forecasts.map(mapSolcastPeriod); source = 'solcast'; }
            } else {
              solcastErrStatus = res.status;
              solcastRetryAfter = res.headers.get('retry-after');
              solcastErrText = `Solcast rooftop HTTP ${res.status}`;
            }
          } catch (e) { solcastErrText = `Solcast rooftop error: ${e.message}`; }
        }
        if (!forecastData && lat && lon) {
          try {
            const tilt = parseFloat(getConfig('solar_tilt')) || 30;
            const azimuth = parseFloat(getConfig('solar_azimuth')) || 180;
            const url = `https://api.solcast.com.au/world_pv_power/forecasts?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&loss_factor=${lossFactor}&install_date=${installDate}&format=json&api_key=${solcastKey}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (res.ok) {
              const data = await res.json();
              if (data.forecasts) { forecastData = data.forecasts.map(mapSolcastPeriod); source = 'solcast'; }
            } else {
              solcastErrStatus = res.status;
              solcastRetryAfter = res.headers.get('retry-after');
              solcastErrText = `Solcast world PV HTTP ${res.status}`;
            }
          } catch (e) { solcastErrText = `Solcast world PV error: ${e.message}`; }
        }

        // --- On failure: populate negative cache (preserve lastGood/lastGoodData) ---
        if (!forecastData) {
          const prior = solcastNegativeCache[forecastSel];
          const entry = computeNegativeCacheEntry(solcastErrText || 'Solcast unavailable', solcastErrStatus, solcastRetryAfter);
          if (prior && prior.lastGood) { entry.lastGood = prior.lastGood; entry.lastGoodData = prior.lastGoodData; }
          solcastNegativeCache[forecastSel] = entry;
        } else {
          // --- On success: clear negative cache for this selector ---
          delete solcastNegativeCache[forecastSel];
        }
      }
    }
  }

  if (!forecastData && forecastSel === 'solcast') return { error: 'Solcast unavailable' };

  if (!forecastData && wantOpenMeteo) {
    if (!lat || !lon) return { error: 'Location required for Open-Meteo' };
    try {
      const openMeteo = await getOpenMeteoData(lat, lon, capacityKwp, lossFactor);
      forecastData = openMeteo.forecasts;
      source = openMeteo.source;
    } catch (e) { return { error: 'All forecast sources unavailable' }; }
  }

  if (!forecastData) return { error: 'All forecast sources unavailable' };

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
    dailyMap.set(date, existing);
  });
  const daily = Array.from(dailyMap.values()).slice(0, 7);
  const todayDate = localDateString();
  for (const dayEntry of daily) {
    dayEntry.total_kwh = Math.round(dayEntry.total_kwh * 100) / 100;
    if (dayEntry.date === todayDate) dayEntry.actual_so_far = actualTodayKwh;
  }

  const hourly = forecastData.slice(0, 96);
  const result = { daily, hourly, source, source_label: SOURCE_LABELS[source] || source };

  // D4: effective source is Solcast and its payload carries air_temp /
  // relative_humidity -> prefer them for weather temp/humidity.
  const ctx = {
    lat, lon, restMap,
    solcastWx: source === 'solcast' ? pickSolcastWeather(forecastData) : { temp: null, humidity: null }
  };
  await attachWeather(result, ctx);

  forecastCache[selector] = { data: result, timestamp: now, ctx };
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
      weather = buildOpenMeteoWeather(await fetchOpenMeteo(lat, lon));
      lastGoodWeather = weather;
    } catch (e) {
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
  result.weather = weather;
  // S2 (AC9, additive): which provider supplied the weather temp/humidity.
  result.weather_source = weatherSource;
}

async function testForecast(opts) {
  // Accept values directly (from form) or fall back to DB config
  const lat = parseFloat(opts?.lat ?? getConfig('solar_latitude'));
  const lon = parseFloat(opts?.lon ?? getConfig('solar_longitude'));
  const capacityKwp = parseFloat(opts?.capacity ?? getConfig('solar_capacity_kwp'));
  if (isNaN(lat) || isNaN(lon) || isNaN(capacityKwp) || capacityKwp <= 0) throw new Error('Invalid location or capacity');
  const solcastKey = opts?.api_key ?? getConfig('solcast_api_key');
  const resourceId = opts?.resource_id ?? getConfig('solcast_resource_id');
  const tilt = parseFloat(opts?.tilt ?? getConfig('solar_tilt')) || 30;
  const azimuth = parseFloat(opts?.azimuth ?? getConfig('solar_azimuth')) || 180;
  const lossFactor = parseFloat(opts?.loss ?? getConfig('solar_loss_factor')) || 0.9;
  const installDate = (opts?.install_date ?? getConfig('solar_install_date')) || '2020-01-01';
  let source = 'none', dailyTotal = 0, peak = 0;

  if (solcastKey) {
    if (resourceId) {
      try {
        const url = `https://api.solcast.com.au/rooftop_sites/${resourceId}/forecasts?format=json&api_key=${solcastKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          const today = localDateString();
          (data.forecasts || []).forEach(f => { if (localDateString(new Date(f.period_end)) === today) { dailyTotal += f.pv_estimate; peak = Math.max(peak, f.pv_estimate); } });
          source = 'solcast';
        }
      } catch (e) { logger.debug(`Solcast rooftop test unavailable: ${e.message}`); }
    }
    if (source === 'none') {
      try {
        const url = `https://api.solcast.com.au/world_pv_power/forecasts?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&loss_factor=${lossFactor}&install_date=${installDate}&format=json&api_key=${solcastKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          const today = localDateString();
          (data.forecasts || []).forEach(f => { if (localDateString(new Date(f.period_end)) === today) { dailyTotal += f.pv_estimate; peak = Math.max(peak, f.pv_estimate); } });
          source = 'solcast';
        }
      } catch (e) { logger.debug(`Solcast world PV test unavailable: ${e.message}`); }
    }
  }
  if (source === 'none') {
    try {
      // Use https.get instead of fetch to avoid ERR_STREAM_PREMATURE_CLOSE
      // (Node.js fetch has stream issues with Open-Meteo in long-running Docker processes)
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&timezone=auto&forecast_days=1`;
      const data = await new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); }
          });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
      });
      // Also fix the Solcast fetch calls the same way (same container, same fetch bug risk)
      const conversionFactor = (capacityKwp / 1000) * lossFactor;
      const today = localDateString();
      data.hourly.time.forEach((t, i) => {
        if (t.startsWith(today)) {
          const pv = data.hourly.shortwave_radiation[i] * conversionFactor;
          dailyTotal += pv; peak = Math.max(peak, pv);
        }
      });
      source = 'open-meteo';
    } catch (e) { throw new Error('Forecast service unavailable'); }
  }
  return { source, today_estimate_kwh: dailyTotal.toFixed(2), peak_kw: peak.toFixed(2) };
}

module.exports = { computeSolarForDate, computeTodaySolar, getSolarForecast, testForecast, weatherCodeMap, DEFAULT_WEATHER, describeWeatherCode, parseOpenMeteo, buildOpenMeteoWeather, periodHours, compassPoint, mapSolcastPeriod, normalizeSourceSelector, pickSolcastWeather, clearForecastCache, resolveDefaultSource, shouldInvalidateForecastCache, FORECAST_CACHE_KEYS, resolveRestSource, REST_DEFAULT_ALIASES, solcastNegativeCache, solcastLastUpstreamAttempt, SOLCAST_UPSTREAM_GATE_MS, SOLCAST_NEGATIVE_TTL_TRANSPORT_MS, SOLCAST_NEGATIVE_TTL_429_BASE_MS, SOLCAST_NEGATIVE_TTL_MAX_MS, clearSolcastNegativeCache, isNegativeCacheValid, computeNegativeCacheEntry, canAttemptSolcastUpstream, recordSolcastUpstreamAttempt, recordSolcastSuccess, buildCachedErrorResponse };
