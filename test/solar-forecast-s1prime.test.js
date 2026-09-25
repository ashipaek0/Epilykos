#!/usr/bin/env node
/**
 * test/solar-forecast-s1prime.test.js — issue #127 S1-prime remainder.
 *
 * Covers (plain node, no framework, no network, no real DB):
 *   - normalizeSourceSelector (auto/default/upper-case/rest:/unknown)
 *   - mapSolcastPeriod (verbatim fwd + unknown field kept + absent->null
 *     + cloud_cover alias + 0 preserved)
 *   - pickSolcastWeather (first-non-null wins, all-absent->nulls)
 *   - getSolarForecast stubbed-config error paths (unknown source, rest:)
 *   - daily null-guard (pv_estimate null -> sums numeric, no NaN)
 *   - per-selector cache (2nd call served from cache, no 2nd fetch)
 *   - D4 solcastWx wiring (Solcast air_temp/relative_humidity win over OM)
 *   - /api/solar-forecast route passes req.query.source through
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

// ---- (A) normalizeSourceSelector ----
check('normalize: undefined->auto', () => assert.strictEqual(solar.normalizeSourceSelector(undefined), 'auto'));
check('normalize: null->auto', () => assert.strictEqual(solar.normalizeSourceSelector(null), 'auto'));
check('normalize: empty->auto', () => assert.strictEqual(solar.normalizeSourceSelector(''), 'auto'));
check('normalize: auto', () => assert.strictEqual(solar.normalizeSourceSelector('auto'), 'auto'));
check('normalize: upper-case SOLCAST', () => assert.strictEqual(solar.normalizeSourceSelector('SOLCAST'), 'solcast'));
check('normalize: mixed-case Open-Meteo', () => assert.strictEqual(solar.normalizeSourceSelector('Open-Meteo'), 'open-meteo'));
check('normalize: rest: passthrough', () => assert.strictEqual(solar.normalizeSourceSelector('rest:mycard'), 'rest:mycard'));
check('normalize: rest: lowercase stays', () => assert.strictEqual(solar.normalizeSourceSelector('rest:foo'), 'rest:foo'));
check('normalize: REST: scheme normalized, suffix case preserved', () => assert.strictEqual(solar.normalizeSourceSelector('REST:MyAPI'), 'rest:MyAPI'));
check('normalize: mixed-case Rest: suffix case preserved', () => assert.strictEqual(solar.normalizeSourceSelector('Rest:MyCard'), 'rest:MyCard'));
check('normalize: unknown->null', () => assert.strictEqual(solar.normalizeSourceSelector('bogus'), null));

// ---- (B) mapSolcastPeriod ----
check('map: verbatim fwd + absent->null', () => {
  const out = solar.mapSolcastPeriod({ period_end: '2026-09-14T12:00:00Z', pv_estimate: 1.5 });
  assert.strictEqual(out.pv_estimate, 1.5);
  assert.strictEqual(out.period_end, '2026-09-14T12:00:00Z');
  assert.strictEqual(out.pv_estimate10, null);
  assert.strictEqual(out.air_temp, null);
});
check('map: unknown future field kept', () => {
  const out = solar.mapSolcastPeriod({ pv_estimate: 1, future_field_x: 'kept' });
  assert.strictEqual(out.future_field_x, 'kept');
});
check('map: cloud_cover alias from cloud_opacity', () => {
  const out = solar.mapSolcastPeriod({ pv_estimate: 1, cloud_opacity: 42 });
  assert.strictEqual(out.cloud_cover, 42);
});
check('map: present cloud_cover not overwritten', () => {
  const out = solar.mapSolcastPeriod({ pv_estimate: 1, cloud_cover: 7, cloud_opacity: 42 });
  assert.strictEqual(out.cloud_cover, 7);
});
check('map: 0 preserved (never rewritten to null)', () => {
  const out = solar.mapSolcastPeriod({ pv_estimate: 0, cloud_opacity: 0 });
  assert.strictEqual(out.pv_estimate, 0);
  assert.strictEqual(out.cloud_cover, 0);
});

// ---- (C) pickSolcastWeather ----
check('pick: first-non-null wins', () => {
  const w = solar.pickSolcastWeather([
    { air_temp: null, relative_humidity: null },
    { air_temp: 28.5, relative_humidity: 61 },
    { air_temp: 99, relative_humidity: 99 }
  ]);
  assert.deepStrictEqual(w, { temp: 28.5, humidity: 61 });
});
check('pick: temp/humidity from different periods', () => {
  const w = solar.pickSolcastWeather([
    { air_temp: 27, relative_humidity: null },
    { air_temp: null, relative_humidity: 55 }
  ]);
  assert.deepStrictEqual(w, { temp: 27, humidity: 55 });
});
check('pick: all-absent->nulls', () => {
  assert.deepStrictEqual(solar.pickSolcastWeather([{}, { air_temp: null }]), { temp: null, humidity: null });
  assert.deepStrictEqual(solar.pickSolcastWeather([]), { temp: null, humidity: null });
});

// ---- (D/E/F/G) getSolarForecast with stubbed fetch + https ----
// Local date: forecast days follow the process time zone (modules/localTime).
const todayStr = require('../modules/localTime').localDateString();
const solcastPeriods = [
  { period_end: `${todayStr}T10:00:00`, pv_estimate: null, air_temp: 28.5, relative_humidity: 61, cloud_opacity: 10 },
  { period_end: `${todayStr}T11:00:00`, pv_estimate: 2.5, air_temp: 29, relative_humidity: 60, cloud_opacity: 20, custom_future: 'fwd' }
];
let fetchCalls = 0;
global.fetch = async () => {
  fetchCalls++;
  return { ok: true, json: async () => ({ forecasts: solcastPeriods }) };
};

// Stub https.get: serve canned Open-Meteo payloads (OM temp 15C / humidity
// 20% deliberately differ from Solcast so D4 override is observable).
const curHour = new Date().getHours();
const pad = (n) => String(n).padStart(2, '0');
const omTime = `${todayStr}T${pad(curHour)}:00`;
function fakeGet(url, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  const isDaily = String(url).includes('daily=');
  const payload = isDaily
    ? { daily: { time: [todayStr, todayStr, todayStr], weathercode: [0, 1, 2], temperature_2m_max: [15, 16, 17], apparent_temperature_max: [14, 15, 16], relativehumidity_2m_mean: [20, 21, 22] } }
    : { current_weather: { temperature: 15, weathercode: 0 }, hourly: { time: [omTime], apparent_temperature: [14], relativehumidity_2m: [20] } };
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

(async () => {
  // ---- (D) stubbed-config error paths ----
  await (async () => {
    solar.clearForecastCache();
    const r = await solar.getSolarForecast('bogus-source');
    assert.ok(r && r.error && /Unknown forecast source/.test(r.error), `expected unknown-source error, got ${JSON.stringify(r)}`);
    passed++;
    console.log('ok - getSolarForecast unknown source -> error');
  })();
  await (async () => {
    solar.clearForecastCache();
    const r = await solar.getSolarForecast('rest:mycard');
    assert.ok(r && r.error && /Source unavailable: rest:mycard/.test(r.error), `expected custom-REST error, got ${JSON.stringify(r)}`);
    passed++;
    console.log('ok - getSolarForecast rest: -> custom-REST error');
  })();
  await (async () => {
    solar.clearForecastCache();
    const r = await solar.getSolarForecast('REST:MyAPI');
    assert.ok(r && r.error && /Source unavailable: rest:MyAPI/.test(r.error), `expected custom-REST error (case), got ${JSON.stringify(r)}`);
    assert.strictEqual(solar.normalizeSourceSelector('REST:MyAPI'), 'rest:MyAPI');
    passed++;
    console.log('ok - getSolarForecast REST:MyAPI -> custom-REST error, case preserved');
  })();

  // ---- (E) daily null-guard + (F) per-selector cache + (G) D4 wx wiring ----
  solar.clearForecastCache();
  fetchCalls = 0;
  const res = await solar.getSolarForecast('solcast');
  check('forecast: solcast source selected', () => assert.strictEqual(res.source, 'solcast'));
  check('daily null-guard: sums numeric, no NaN', () => {
    assert.ok(Array.isArray(res.daily) && res.daily.length > 0, 'daily missing');
    for (const d of res.daily) {
      assert.strictEqual(typeof d.total_kwh, 'number');
      assert.strictEqual(typeof d.peak_kw, 'number');
      assert.ok(!Number.isNaN(d.total_kwh) && !Number.isNaN(d.peak_kw), `NaN in ${JSON.stringify(d)}`);
    }
    const today = res.daily.find((d) => d.date === todayStr);
    assert.ok(today, 'today entry missing');
    assert.strictEqual(today.total_kwh, 2.5); // null pv_estimate contributed 0
    assert.strictEqual(today.peak_kw, 2.5);
  });
  check('D4: solcast temp/humidity override Open-Meteo', () => {
    assert.ok(res.weather, 'weather missing');
    assert.strictEqual(res.weather.temp, 28.5);
    assert.ok(res.weather.extra.includes('Humidity 61%'), `extra missing solcast humidity: ${res.weather.extra}`);
  });
  check('hourly: unknown upstream field forwarded verbatim', () => {
    const p = res.hourly.find((h) => h.custom_future === 'fwd');
    assert.ok(p, 'custom_future field stripped');
  });
  const callsAfterFirst = fetchCalls;
  const res2 = await solar.getSolarForecast('solcast');
  check('cache: 2nd call served from per-selector cache (no refetch)', () => {
    assert.strictEqual(fetchCalls, callsAfterFirst);
    assert.strictEqual(res2, res);
  });

  // ---- (H) route passthrough (static check) ----
  check('route: /api/solar-forecast passes req.query.source', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'routes', 'metrics.js'), 'utf8');
    assert.ok(srv.includes('getSolarForecast(req.query.source'), 'route does not forward req.query.source');
  });

  console.log(`\nPASS solar-forecast-s1prime: ${passed} checks`);
})().catch((e) => {
  console.error(`FAIL: ${e.stack || e}`);
  process.exit(1);
});
