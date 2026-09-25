#!/usr/bin/env node
/**
 * test/forecast-weather.test.js — weather/forecast payload the dashboard cards
 * render from (modules/solar.js).
 *
 * Covers: every WMO code maps to a real description (thunderstorm is not
 * "Clear Sky"), night icons, unknown codes never claim clear sky; Open-Meteo
 * parsing (unixtime + location dates); the rich weather object (current
 * details, today, up to 6 forecast days, next-24h hourly); Solcast 30-minute
 * periods count half an hour of energy; Open-Meteo failure yields an
 * "unavailable" placeholder instead of a fake sunny day; a cached forecast
 * still gets fresh weather and keeps its object identity.
 *
 * DB/network isolation: modules/database.js is stubbed in the require cache;
 * global.fetch and https.get are stubbed.
 */
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const cfg = {
  forecast_enabled: 'true',
  solar_latitude: '6.5',
  solar_longitude: '3.4',
  solar_capacity_kwp: '5',
  solcast_api_key: '',
  solar_loss_factor: '0.9',
  forecast_default_source: 'auto',
  weather_default_source: 'auto'
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
const { openMeteoPayload } = require('./open-meteo-fixture');
const { localDateString } = require('../modules/localTime');

let omFail = false;
let omCalls = 0;
https.get = function fakeGet(url, opts, cb) {
  if (typeof opts === 'function') cb = opts;
  omCalls++;
  const res = new EventEmitter();
  res.statusCode = omFail ? 503 : 200;
  res.setEncoding = () => {};
  res.resume = () => {};
  process.nextTick(() => {
    cb(res);
    if (!omFail) { res.emit('data', JSON.stringify(openMeteoPayload())); res.emit('end'); }
  });
  const req = new EventEmitter();
  req.destroy = () => {};
  return req;
};

(async () => {
  // ---- weather codes ----
  await check('code 95 is a thunderstorm, not clear sky', () => {
    const w = solar.describeWeatherCode(95, true);
    assert.strictEqual(w.desc, 'Thunderstorm');
    assert.ok(w.icon_class.includes('thunderstorm'));
  });
  await check('every documented WMO code has a description', () => {
    for (const c of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
      assert.ok(solar.describeWeatherCode(c).desc, `code ${c} undescribed`);
    }
  });
  await check('clear night uses the moon icon', () => {
    assert.ok(solar.describeWeatherCode(0, false).icon_class.includes('moon'));
  });
  await check('unknown / missing code never claims clear sky', () => {
    assert.notStrictEqual(solar.describeWeatherCode(12345).desc, 'Clear Sky');
    assert.strictEqual(solar.describeWeatherCode(null).desc, '');
  });

  // ---- parsing ----
  await check('parseOpenMeteo: unixtime hourly + location-local daily dates', () => {
    const t = Date.UTC(2026, 8, 24, 23, 0) / 1000; // 23:00 UTC = 00:00 next day at UTC+1
    const om = solar.parseOpenMeteo({
      utc_offset_seconds: 3600,
      hourly: { time: [t], temperature_2m: [21] },
      daily: { time: [t], weather_code: [2], sunrise: [t + 6 * 3600] }
    });
    assert.strictEqual(om.hourly[0].ms, t * 1000);
    assert.strictEqual(om.hourly[0].temp, 21);
    assert.strictEqual(om.daily[0].date, '2026-09-25');
    assert.strictEqual(om.daily[0].sunrise, (t + 6 * 3600) * 1000);
  });
  await check('periodHours: Solcast PT30M is half an hour, default 1 h', () => {
    assert.strictEqual(solar.periodHours({ period: 'PT30M' }), 0.5);
    assert.strictEqual(solar.periodHours({ period: 'PT1H' }), 1);
    assert.strictEqual(solar.periodHours({}), 1);
  });
  await check('compassPoint: 225° → SW', () => assert.strictEqual(solar.compassPoint(225), 'SW'));

  // ---- full forecast payload (Open-Meteo) ----
  solar.clearForecastCache();
  cfg.forecast_default_source = 'open-meteo';
  const res = await solar.getSolarForecast('open-meteo');
  const w = res.weather;
  await check('weather: current details present', () => {
    assert.strictEqual(w.available, true);
    assert.strictEqual(w.temp, 15);
    assert.strictEqual(w.feels_like, 14);
    assert.strictEqual(w.humidity, 20);
    assert.strictEqual(w.wind_speed, 3.2);
    assert.strictEqual(w.wind_compass, 'SW');
    assert.strictEqual(w.pressure, 1013.2);
    assert.strictEqual(w.uv_index, 5.5);
    assert.strictEqual(w.cloud_cover, 10);
    assert.strictEqual(w.desc, 'Clear Sky');
    assert.ok(w.extra.includes('Humidity 20%'));
  });
  await check('weather: today hi/lo + sunrise/sunset', () => {
    assert.strictEqual(w.today.temp_max, 15);
    assert.strictEqual(w.today.temp_min, 9);
    assert.ok(w.sunrise && w.sunset);
  });
  await check('weather: forecast days after today, with rain chance', () => {
    assert.strictEqual(w.forecast_weather.length, 2);
    assert.ok(w.forecast_weather.every(d => d.date > localDateString()));
    assert.strictEqual(w.forecast_weather[1].desc, 'Thunderstorm');
    assert.strictEqual(w.forecast_weather[1].precip_probability, 80);
    assert.strictEqual(w.forecast_weather[1].temp_min, 11);
  });
  await check('weather: hourly strip carries icons and temps', () => {
    assert.ok(Array.isArray(w.hourly) && w.hourly.length >= 1);
    assert.ok(w.hourly.every(h => h.icon_class && h.time));
  });
  await check('open-meteo hourly periods carry weather + energy', () => {
    const h = res.hourly.find(x => x.shortwave_radiation === 900);
    assert.ok(h, 'OM period missing');
    assert.strictEqual(h.weather_code, 2);
    assert.strictEqual(h.relative_humidity, 58);
    assert.ok(Math.abs(h.energy_kwh - 900 * 5 / 1000 * 0.9) < 1e-9);
  });

  // ---- cache keeps identity but refreshes weather ----
  const callsBefore = omCalls;
  const res2 = await solar.getSolarForecast('open-meteo');
  await check('cache hit: same object, no extra Open-Meteo call within 15 min', () => {
    assert.strictEqual(res2, res);
    assert.strictEqual(omCalls, callsBefore);
  });

  // ---- Solcast 30-minute periods ----
  solar.clearForecastCache();
  cfg.forecast_default_source = 'solcast';
  cfg.solcast_api_key = 'KEY';
  cfg.solcast_resource_id = 'RES';
  const today = localDateString();
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ forecasts: [
      { period_end: `${today}T11:00:00`, period: 'PT30M', pv_estimate: 2 },
      { period_end: `${today}T11:30:00`, period: 'PT30M', pv_estimate: 4 }
    ] })
  });
  const sol = await solar.getSolarForecast('solcast');
  await check('solcast: 30-min periods count half an hour of energy', () => {
    const d = sol.daily.find(x => x.date === today);
    assert.strictEqual(d.total_kwh, 3); // (2 + 4) kW × 0.5 h
    assert.strictEqual(d.peak_kw, 4);
  });

  // ---- Open-Meteo down: no fake "Clear Sky" ----
  solar.clearForecastCache();
  omFail = true;
  cfg.forecast_default_source = 'solcast';
  const down = await solar.getSolarForecast('solcast');
  await check('open-meteo down: weather flagged unavailable, not sunny', () => {
    assert.strictEqual(down.weather.available, false);
    assert.strictEqual(down.weather.temp, null);
    assert.notStrictEqual(down.weather.desc, 'Clear Sky');
  });

  console.log(`\nPASS forecast-weather: ${passed} checks`);
  process.exit(0);
})().catch((e) => {
  console.error(`FAIL: ${e.stack || e}`);
  process.exit(1);
});
