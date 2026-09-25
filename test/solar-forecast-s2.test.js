#!/usr/bin/env node
/**
 * test/solar-forecast-s2.test.js — issue #127 S2 (AC9: global default sources).
 *
 * Covers (plain node, no framework, no network, no real DB):
 *   - resolveDefaultSource (valid / invalid->auto / empty->auto)
 *   - shouldInvalidateForecastCache (relevant key true, unrelated false,
 *     array + object forms)
 *   - auto + global solcast-only, no solcast key -> 'Solcast unavailable',
 *     no OM cascade
 *   - auto + global open-meteo -> Open-Meteo path
 *   - auto + invalid global -> cascade (Solcast wins when key present)
 *   - weather_source: solcast vs open-meteo vs fallback (solcast default
 *     but no Solcast temp/humidity -> Open-Meteo fallback)
 *   - settings-save hook wired (server.js references the helpers; the solar
 *     per-section route accepts the two new keys; data-sources writes no
 *     forecast keys so needs no hook)
 *
 * DB/network isolation: modules/database.js is pre-seeded in the require
 * cache BEFORE modules/solar.js loads, so getConfig/getDb are stubs and the
 * repo's real DB is never touched. global.fetch and https.get are stubbed.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---- Stub modules/database.js in the require cache before solar.js loads ----
const cfg = {
  forecast_enabled: 'true',
  solar_latitude: '6.5',
  solar_longitude: '3.4',
  solar_capacity_kwp: '5',
  solcast_api_key: 'STUBKEY',
  solcast_resource_id: 'STUBRES',
  solar_loss_factor: '0.9',
  solar_install_date: '2020-01-01',
  solar_tilt: '30',
  solar_azimuth: '180',
  forecast_default_source: 'auto',
  weather_default_source: 'auto',
  savings_solar_metric: ''
};
const dbId = require.resolve('../modules/database');
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: {
    getConfig: (k) => cfg[k],
    flushMetrics: () => 0,
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) })
  }
};

const solar = require('../modules/solar');
const https = require('https');

// ---- Stubbed upstream payloads ----
// Local date: forecast days follow the process time zone (modules/localTime).
const todayStr = require('../modules/localTime').localDateString();
// Solcast periods WITH temp/humidity (Solcast weather observable).
let solcastPeriods = [
  { period_end: `${todayStr}T10:00:00`, pv_estimate: 1.5, air_temp: 28.5, relative_humidity: 61, cloud_opacity: 10 },
  { period_end: `${todayStr}T11:00:00`, pv_estimate: 2.5, air_temp: 29, relative_humidity: 60, cloud_opacity: 20 }
];
let fetchCalls = 0;
global.fetch = async () => {
  fetchCalls++;
  return { ok: true, json: async () => ({ forecasts: solcastPeriods }) };
};

// Open-Meteo stubs: forecast (hourly shortwave_radiation), current weather
// (OM temp 15C / humidity 20% deliberately differ from Solcast so the
// weather_source switch is observable), and daily weathercode.
const curHour = new Date().getHours();
const pad = (n) => String(n).padStart(2, '0');
const omTime = `${todayStr}T${pad(curHour)}:00`;
let omForecastCalls = 0;
function fakeGet(url, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  const u = String(url);
  let payload;
  if (u.includes('shortwave_radiation')) {
    omForecastCalls++;
    payload = {
      hourly: {
        time: [`${todayStr}T10:00:00`, `${todayStr}T11:00:00`],
        shortwave_radiation: [800, 900],
        cloud_cover: [10, 20]
      }
    };
  } else if (u.includes('daily=')) {
    payload = { daily: { time: [todayStr, todayStr, todayStr], weathercode: [0, 1, 2], temperature_2m_max: [15, 16, 17], apparent_temperature_max: [14, 15, 16], relativehumidity_2m_mean: [20, 21, 22] } };
  } else {
    payload = { current_weather: { temperature: 15, weathercode: 0 }, hourly: { time: [omTime], apparent_temperature: [14], relativehumidity_2m: [20] } };
  }
  const body = JSON.stringify(payload);
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setEncoding = () => {};
  process.nextTick(() => {
    cb(res);
    res.emit('data', body);
    res.emit('end');
  });
  const req = new EventEmitter();
  req.destroy = () => {};
  return req;
}
https.get = fakeGet;

// ---- (A) resolveDefaultSource ----
check('resolveDefaultSource: valid solcast', () => {
  cfg.forecast_default_source = 'solcast';
  assert.strictEqual(solar.resolveDefaultSource('forecast_default_source'), 'solcast');
});
check('resolveDefaultSource: invalid->auto', () => {
  cfg.forecast_default_source = 'bogus';
  assert.strictEqual(solar.resolveDefaultSource('forecast_default_source'), 'auto');
});
check('resolveDefaultSource: empty/unset->auto', () => {
  cfg.forecast_default_source = '';
  assert.strictEqual(solar.resolveDefaultSource('forecast_default_source'), 'auto');
  delete cfg.forecast_default_source;
  assert.strictEqual(solar.resolveDefaultSource('forecast_default_source'), 'auto');
  cfg.forecast_default_source = 'auto';
});

// ---- (B) shouldInvalidateForecastCache ----
check('invalidate: relevant key true (array form)', () => {
  assert.strictEqual(solar.shouldInvalidateForecastCache(['forecast_default_source']), true);
  assert.strictEqual(solar.shouldInvalidateForecastCache(['dashboard_title', 'solar_latitude']), true);
});
check('invalidate: relevant key true (object/body form)', () => {
  assert.strictEqual(solar.shouldInvalidateForecastCache({ forecast_enabled: 'true' }), true);
  assert.strictEqual(solar.shouldInvalidateForecastCache({ weather_default_source: 'solcast' }), true);
});
check('invalidate: unrelated false', () => {
  assert.strictEqual(solar.shouldInvalidateForecastCache(['dashboard_title']), false);
  assert.strictEqual(solar.shouldInvalidateForecastCache({ user_metrics: '[]' }), false);
  assert.strictEqual(solar.shouldInvalidateForecastCache([]), false);
  assert.strictEqual(solar.shouldInvalidateForecastCache({}), false);
});

(async () => {
  // ---- (C) auto + global solcast-only, no key -> hard error, no cascade ----
  solar.clearForecastCache();
  cfg.forecast_default_source = 'solcast';
  cfg.weather_default_source = 'auto';
  cfg.solcast_api_key = '';
  omForecastCalls = 0;
  const rNoKey = await solar.getSolarForecast('auto');
  check('auto+global solcast, no key -> Solcast unavailable', () => {
    assert.ok(rNoKey && rNoKey.error === 'Solcast unavailable', `got ${JSON.stringify(rNoKey)}`);
  });
  check('auto+global solcast, no key -> no OM cascade', () => {
    assert.strictEqual(omForecastCalls, 0, `OM forecast fetched ${omForecastCalls}x`);
  });

  // ---- (D) auto + global open-meteo -> OM path ----
  solar.clearForecastCache();
  cfg.forecast_default_source = 'open-meteo';
  cfg.solcast_api_key = 'STUBKEY'; // present but must be ignored
  fetchCalls = 0;
  const rOm = await solar.getSolarForecast('auto');
  check('auto+global open-meteo -> open-meteo source', () => {
    assert.strictEqual(rOm.source, 'open-meteo');
  });
  check('auto+global open-meteo -> solcast never fetched', () => {
    assert.strictEqual(fetchCalls, 0, `solcast fetched ${fetchCalls}x`);
  });

  // ---- (E) auto + invalid global -> cascade (Solcast wins) ----
  solar.clearForecastCache();
  cfg.forecast_default_source = 'bogus';
  const rCascade = await solar.getSolarForecast('auto');
  check('auto+invalid global -> cascade, solcast wins', () => {
    assert.strictEqual(rCascade.source, 'solcast');
  });

  // ---- (F) weather_source: solcast vs open-meteo vs fallback ----
  solcastPeriods = [
    { period_end: `${todayStr}T10:00:00`, pv_estimate: 1.5, air_temp: 28.5, relative_humidity: 61, cloud_opacity: 10 },
    { period_end: `${todayStr}T11:00:00`, pv_estimate: 2.5, air_temp: 29, relative_humidity: 60, cloud_opacity: 20 }
  ];
  solar.clearForecastCache();
  cfg.forecast_default_source = 'auto';
  cfg.weather_default_source = 'auto';
  const rWxSol = await solar.getSolarForecast('auto');
  check('weather_source solcast (auto default + solcast temp)', () => {
    assert.strictEqual(rWxSol.weather_source, 'solcast');
    assert.strictEqual(rWxSol.weather.temp, 28.5);
  });

  solar.clearForecastCache();
  cfg.weather_default_source = 'open-meteo';
  const rWxOm = await solar.getSolarForecast('auto');
  check('weather_source open-meteo (OM-only default)', () => {
    assert.strictEqual(rWxOm.weather_source, 'open-meteo');
    assert.strictEqual(rWxOm.weather.temp, 15);
  });

  // Rooftop-shaped payload: no air_temp/relative_humidity anywhere.
  solcastPeriods = [
    { period_end: `${todayStr}T10:00:00`, pv_estimate: 1.5 },
    { period_end: `${todayStr}T11:00:00`, pv_estimate: 2.5 }
  ];
  solar.clearForecastCache();
  cfg.weather_default_source = 'solcast';
  const rWxFb = await solar.getSolarForecast('auto');
  check('weather_source fallback (solcast default, no solcast temp -> OM)', () => {
    assert.strictEqual(rWxFb.source, 'solcast');
    assert.strictEqual(rWxFb.weather_source, 'open-meteo');
    assert.strictEqual(rWxFb.weather.temp, 15);
  });

  // ---- (G) settings-save hook wired (static checks) ----
  check('hook: server.js calls shouldInvalidateForecastCache+clearForecastCache', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(srv.includes('shouldInvalidateForecastCache'), 'helper not referenced');
    assert.ok(srv.includes('clearForecastCache()'), 'clear call not wired');
  });
  check('hook: solar per-section route accepts the S2 default keys', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const solarSlice = srv.slice(srv.indexOf('/api/settings/solar'));
    assert.ok(solarSlice.includes('forecast_default_source'), 'solar route missing forecast_default_source');
    assert.ok(solarSlice.includes('weather_default_source'), 'solar route missing weather_default_source');
  });
  check('hook: data-sources route writes no forecast keys (no hook needed)', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const dsStart = srv.indexOf('/api/settings/data-sources');
    const dsSlice = srv.slice(dsStart, srv.indexOf('/api/settings/metrics'));
    for (const k of solar.FORECAST_CACHE_KEYS) {
      assert.ok(!dsSlice.includes(`'${k}'`), `data-sources slice unexpectedly mentions ${k}`);
    }
  });

  console.log(`\nPASS solar-forecast-s2: ${passed} checks`);
})().catch((e) => {
  console.error(`FAIL: ${e.stack || e}`);
  process.exit(1);
});
