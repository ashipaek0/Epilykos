'use strict';
const checks = require('./_checks');
// Several PV arrays: the list, Open-Meteo per array with tilted irradiance,
// Solcast forecasts added up. Network and database are stubbed.
const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

const cfg = {};
const dbId = require.resolve('../modules/database');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { getConfig: k => cfg[k], setConfig: (k, v) => { cfg[k] = String(v); }, flushMetrics: () => 0, getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }) } };

// Open-Meteo stub: two hours; horizontal 500 W/m2; tilted depends on azimuth.
const hours = [1791273600, 1791277200];
const requests = [];
https.get = (url, opts, cb) => {
  requests.push(String(url));
  const u = new URL(String(url));
  let body;
  if (u.searchParams.get('hourly') === 'global_tilted_irradiance') {
    const az = Number(u.searchParams.get('azimuth'));
    if (az === 45) { const res = new EventEmitter(); res.statusCode = 500; res.resume = () => {}; setImmediate(() => cb(res)); return { on() { return this; }, destroy() {} }; }
    body = { hourly: { time: hours, global_tilted_irradiance: az < 0 ? [800, 200] : [200, 800] } };   // east strong early, west late
  } else {
    body = { utc_offset_seconds: 0, hourly: { time: hours, shortwave_radiation: [500, 500], temperature_2m: [25, 26], weather_code: [1, 1], cloud_cover: [10, 10], is_day: [1, 1] }, daily: { time: [], sunrise: [], sunset: [] }, current: {} };
  }
  const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {};
  setImmediate(() => { cb(res); res.emit('data', JSON.stringify(body)); res.emit('end'); });
  return { on() { return this; }, destroy() {} };
};
const solar = require('../modules/solar');

(async () => {
  await check('arrays: the saved list, or the single array from before', () => {
    cfg.solar_capacity_kwp = '5'; cfg.solar_tilt = '25'; cfg.solar_azimuth = '160';
    assert.deepStrictEqual(solar.getArrays().map(a => [a.kwp, a.tilt, a.azimuth]), [[5, 25, 160]]);
    cfg.solar_arrays = JSON.stringify([{ name: 'East', kwp: 3, tilt: 20, azimuth: 90 }, { name: 'West', kwp: 2, tilt: 20, azimuth: 270 }, { name: 'Empty', kwp: 0 }]);
    assert.deepStrictEqual(solar.getArrays().map(a => [a.name, a.kwp, a.azimuth]), [['East', 3, 90], ['West', 2, 270]], 'arrays without capacity are left out');
    assert.strictEqual(solar.getArrays({ capacity: 4, tilt: 10, azimuth: 200 })[0].kwp, 4, 'Test forecast form values win');
  });

  await check('compass azimuth converts to Open-Meteo\'s (0 = south)', () => {
    assert.strictEqual(solar.openMeteoAzimuth(180), 0); assert.strictEqual(solar.openMeteoAzimuth(90), -90);
    assert.strictEqual(solar.openMeteoAzimuth(270), 90); assert.strictEqual(solar.openMeteoAzimuth(0), -180);
  });

  await check('Solcast forecasts from several arrays add up period by period, bands too', () => {
    const t1 = '2026-10-07T10:00:00Z', t2 = '2026-10-07T10:30:00Z';
    const out = solar.sumForecastPeriods([[{ period_end: t1, pv_estimate: 1, pv_estimate10: 0.5, pv_estimate90: 1.5, cloud_cover: 10 }, { period_end: t2, pv_estimate: 2 }], [{ period_end: t1, pv_estimate: 3, pv_estimate10: 2, pv_estimate90: 4 }]]);
    assert.deepStrictEqual(out.map(p => p.pv_estimate), [4, 2]);
    assert.strictEqual(out[0].pv_estimate10, 2.5); assert.strictEqual(out[0].pv_estimate90, 5.5); assert.strictEqual(out[0].cloud_cover, 10);
  });

  await check('Open-Meteo: each array uses its own tilted irradiance, then they add up', async () => {
    const arrays = [{ name: 'East', kwp: 3, tilt: 20, azimuth: 90 }, { name: 'West', kwp: 2, tilt: 20, azimuth: 270 }];
    const om = await solar.getOpenMeteoArrays(6.5, 3.4, arrays, 1);
    // hour 1: east 800*3 + west 200*2 = 2800 W; hour 2: 200*3 + 800*2 = 2200 W
    assert.deepStrictEqual(om.forecasts.map(f => Math.round(f.pv_estimate * 1000)), [2800, 2200]);
    assert.ok(requests.some(u => /tilt=20/.test(u) && /azimuth=-90/.test(u)), 'east array asked with azimuth -90');
    assert.deepStrictEqual(om.arrays.map(a => a.tilted), [true, true]);
  });

  await check('an array whose tilted request fails uses horizontal irradiance instead of dropping out', async () => {
    const om = await solar.getOpenMeteoArrays(6.5, 3.4, [{ name: 'SW', kwp: 2, tilt: 30, azimuth: 225 }], 0.9);
    assert.deepStrictEqual(om.forecasts.map(f => +f.pv_estimate.toFixed(3)), [0.9, 0.9]);   // 500 W/m2 x 2 kWp x 0.9
    assert.strictEqual(om.arrays[0].tilted, false);
  });

  await check('Settings: arrays saved as one field; total kWp kept as the system capacity', () => {
    const fs = require('fs'), path = require('path'), read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(read('public/settings.html'), /type="hidden" id="solar-arrays" name="solar_arrays"/);
    const js = read('public/js/pv-arrays.js');
    assert.match(js, /set\('solar-capacity', total/); assert.match(js, /e\.target\.id === 'solar-arrays'\) init\(\)/);
    assert.match(read('server.js'), /'solcast_resource_id', 'solar_arrays'/);
  });

  console.log(`solar-arrays: ${passed} checks passed`);
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
