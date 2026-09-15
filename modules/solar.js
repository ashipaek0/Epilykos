const { logger } = require('./logger');
const https = require('https');
const { getConfig, getDb } = require('./database');

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
      for (var i = 0; i < allMetrics.length; i++) {
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

const weatherCodeMap = {
  0: { icon: 'fi fi-sr-sun', desc: 'Clear Sky' },
  1: { icon: 'fi fi-sr-sun', desc: 'Mainly Clear' },
  2: { icon: 'fi fi-sr-cloud-sun', desc: 'Partly Cloudy' },
  3: { icon: 'fi fi-sr-cloud', desc: 'Overcast' },
  45: { icon: 'fi fi-sr-cloud', desc: 'Fog' },
  48: { icon: 'fi fi-sr-cloud', desc: 'Depositing Rime Fog' },
  51: { icon: 'fi fi-sr-cloud-rain', desc: 'Light Drizzle' },
  53: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Drizzle' },
  55: { icon: 'fi fi-sr-cloud-rain', desc: 'Dense Drizzle' },
  61: { icon: 'fi fi-sr-cloud-rain', desc: 'Slight Rain' },
  63: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Rain' },
  65: { icon: 'fi fi-sr-cloud-rain', desc: 'Heavy Rain' },
  80: { icon: 'fi fi-sr-cloud-rain', desc: 'Rain Showers' }
};
const DEFAULT_WEATHER = { icon: 'fi fi-sr-sun', desc: 'Clear Sky' };

async function getOpenMeteoData(lat, lon, capacityKwp, lossFactor) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation,cloud_cover,temperature_2m&timezone=auto&forecast_days=4`;
  const data = await new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
  const conversionFactor = (capacityKwp / 1000) * (lossFactor || 0.9);
  const hourly = data.hourly;
  const forecasts = hourly.time.map((t, i) => {
    const sw = Number(hourly.shortwave_radiation?.[i]);
    const at = Number(hourly.temperature_2m?.[i]);
    return {
      period_end: new Date(t).toISOString(),
      pv_estimate: hourly.shortwave_radiation[i] * conversionFactor,
      cloud_cover: hourly.cloud_cover?.[i] ?? null,
      air_temp: Number.isFinite(at) ? at : null,
      shortwave_radiation: Number.isFinite(sw) ? sw : null
    };
  });
  return { forecasts, source: 'open-meteo' };
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
function clearForecastCache() { forecastCache = {}; solcastNegativeCache = {}; solcastLastUpstreamAttempt = 0; }

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
  try { rows = getDb().prepare('SELECT metric, value, value_text FROM latest_metrics').all(); } catch (e) { rows = []; }
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
    const cacheDate = cached.data.daily[0]?.date;
    const todayDate = new Date().toLocaleDateString('en-CA');
    // Invalidate if date changed, or if cached data is missing cloud_cover (stale cache from older code)
    const hasCloudCover = cached.data.hourly?.length && cached.data.hourly[0].cloud_cover != null;
    if (cacheDate !== todayDate || !hasCloudCover) delete forecastCache[selector];
    else return cached.data;
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
    const date = String(f.period_end || '').split('T')[0];
    const existing = dailyMap.get(date) || { date, total_kwh: 0, peak_kw: 0, source };
    const n = Number(f.pv_estimate);
    const pv = Number.isFinite(n) ? n : 0; // AC3a: null/absent -> 0 in sums, never NaN
    existing.total_kwh += pv;
    existing.peak_kw = Math.max(existing.peak_kw, pv);
    dailyMap.set(date, existing);
  });
  const daily = Array.from(dailyMap.values()).slice(0, 4);
  const todayDate = new Date().toLocaleDateString('en-CA');
  for (const dayEntry of daily) if (dayEntry.date === todayDate) dayEntry.actual_so_far = actualTodayKwh;

  const hourly = forecastData.slice(0, 96);
  const result = { daily, hourly, source, source_label: SOURCE_LABELS[source] || source };

  // D4: effective source is Solcast and its payload carries air_temp /
  // relative_humidity -> prefer them for weather temp/extra. Rooftop
  // payloads carry neither -> Open-Meteo fallback below still applies.
  // Icons/weathercode path is unchanged (stays Open-Meteo).
  const solcastWx = source === 'solcast' ? pickSolcastWeather(forecastData) : { temp: null, humidity: null };

  // Weather data
  // S2 (AC9): global weather default. 'auto' = today's behavior (prefer
  // Solcast temp/humidity when this run produced them, else OM fallback);
  // 'open-meteo' = OM only (ignore solcastWx); 'solcast' = solcastWx when
  // available else OM fallback. Icons/weathercode always stay Open-Meteo.
  const weatherSelRaw = resolveDefaultSource('weather_default_source');
  // S5-backend: a rest: weather default resolves through latest_metrics;
  // on resolver error fall back to 'auto' (previous behavior).
  let restWeather = null;
  if (weatherSelRaw.startsWith('rest:')) {
    const resolved = resolveRestSource(weatherSelRaw.slice(5), restMap);
    if (!resolved.error) restWeather = resolved;
  }
  const weatherSel = restWeather ? weatherSelRaw : (weatherSelRaw.startsWith('rest:') ? 'auto' : weatherSelRaw);
  const useSolcastWx = weatherSel !== 'open-meteo';
  let weatherSource = 'open-meteo';
  if (lat && lon) {
    try {
      const currentUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relativehumidity_2m,apparent_temperature&timezone=auto&forecast_days=1`;
      const currentData = await new Promise((resolve, reject) => {
        const req = https.get(currentUrl, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); } });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
      });
      let temp = null, feelsLike = null, humidity = null, iconClass = DEFAULT_WEATHER.icon, weatherDesc = DEFAULT_WEATHER.desc;
        const cw = currentData.current_weather;
        temp = cw.temperature;
        const code = cw.weathercode;
        const mapping = weatherCodeMap[code] || DEFAULT_WEATHER;
        iconClass = mapping.icon; weatherDesc = mapping.desc;
        const hourlyData = currentData.hourly;
        const times = hourlyData.time.map(t => new Date(t));
        for (let i = 0; i < times.length; i++) {
          if (times[i].getHours() === new Date().getHours()) {
            feelsLike = hourlyData.apparent_temperature[i];
            humidity = hourlyData.relativehumidity_2m[i];
            break;
          }
        }
      let forecastWeather = [];
      const dailyWeatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,apparent_temperature_max,relativehumidity_2m_mean&timezone=auto&forecast_days=3`;
      const dailyData = await new Promise((resolve, reject) => {
        const req = https.get(dailyWeatherUrl, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); } });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
      });
      if (dailyData.daily) {
        const dates = dailyData.daily.time;
        const codes = dailyData.daily.weathercode;
        const temps = dailyData.daily.temperature_2m_max;
        const feels = dailyData.daily.apparent_temperature_max;
        const humids = dailyData.daily.relativehumidity_2m_mean;
        for (let i = 1; i <= 2 && i < dates.length; i++) {
          const mapping = weatherCodeMap[codes[i]] || DEFAULT_WEATHER;
          const d = new Date(dates[i] + 'T12:00:00');
          forecastWeather.push({
            date: dates[i],
            day_name: d.toLocaleDateString('en-US', { weekday: 'long' }),
            icon_class: mapping.icon,
            desc: mapping.desc,
            temp: temps[i],
            extra: (feels[i] != null ? `Feels ${feels[i].toFixed(0)}°C` : '') + (humids[i] != null ? ` · Humidity ${humids[i].toFixed(0)}%` : '')
          });
        }
      }
      if (useSolcastWx) {
        if (solcastWx.temp != null) temp = solcastWx.temp;
        if (solcastWx.humidity != null) humidity = solcastWx.humidity;
        if (solcastWx.temp != null || solcastWx.humidity != null) weatherSource = 'solcast';
      }
      result.weather = {
        icon_class: iconClass, desc: weatherDesc, temp,
        extra: (feelsLike != null ? `Feels ${feelsLike.toFixed(0)}°C` : '') + (humidity != null ? ` · Humidity ${humidity}%` : ''),
        forecast_weather: forecastWeather
      };
      // S5-backend: rest: weather default wins over OM/solcast point values.
      if (restWeather) {
        result.weather = restWeather.weather;
        weatherSource = restWeather.weather_source;
      }
    } catch (e) {
      result.weather = { icon_class: DEFAULT_WEATHER.icon, desc: DEFAULT_WEATHER.desc, temp: null, extra: '', forecast_weather: [] };
    }
  } else {
    result.weather = { icon_class: DEFAULT_WEATHER.icon, desc: DEFAULT_WEATHER.desc, temp: null, extra: '', forecast_weather: [] };
  }

  // S2 (AC9, additive): which provider supplied the weather temp/humidity.
  result.weather_source = weatherSource;

  forecastCache[selector] = { data: result, timestamp: now };
  return result;
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
          const today = new Date().toISOString().split('T')[0];
          (data.forecasts || []).forEach(f => { if (f.period_end.startsWith(today)) { dailyTotal += f.pv_estimate; peak = Math.max(peak, f.pv_estimate); } });
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
          const today = new Date().toISOString().split('T')[0];
          (data.forecasts || []).forEach(f => { if (f.period_end.startsWith(today)) { dailyTotal += f.pv_estimate; peak = Math.max(peak, f.pv_estimate); } });
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
      const today = new Date().toISOString().split('T')[0];
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

module.exports = { computeSolarForDate, computeTodaySolar, getSolarForecast, testForecast, weatherCodeMap, DEFAULT_WEATHER, mapSolcastPeriod, normalizeSourceSelector, pickSolcastWeather, clearForecastCache, resolveDefaultSource, shouldInvalidateForecastCache, FORECAST_CACHE_KEYS, resolveRestSource, REST_DEFAULT_ALIASES, solcastNegativeCache, solcastLastUpstreamAttempt, SOLCAST_UPSTREAM_GATE_MS, SOLCAST_NEGATIVE_TTL_TRANSPORT_MS, SOLCAST_NEGATIVE_TTL_429_BASE_MS, SOLCAST_NEGATIVE_TTL_MAX_MS, clearSolcastNegativeCache, isNegativeCacheValid, computeNegativeCacheEntry, canAttemptSolcastUpstream, recordSolcastUpstreamAttempt, recordSolcastSuccess, buildCachedErrorResponse };
