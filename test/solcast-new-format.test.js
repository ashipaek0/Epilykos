'use strict';
const checks = require('./_checks');
// Solcast: the location-based forecast uses the current API and response format (version 3), and every weather and
// irradiance value Solcast offers is requested, merged into the forecast periods, summarised per day, shown on the
// weather card and published as solcast_* metrics. Solcast itself is stubbed (global.fetch), from its documentation.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-solcast-')));
const { initializeDatabase, getDb, setConfig, getConfig, flushMetrics } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const solar = require(path.join(REPO, 'modules/solar'));
const https = require('https');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');

// Open-Meteo is not reachable here: fail fast so the weather card falls back to Solcast's values.
https.get = () => { const req = new EventEmitter(); req.destroy = () => {}; process.nextTick(() => req.emit('error', new Error('offline'))); return req; };

const DOCUMENTED_WEATHER = ['air_temp', 'min_air_temp', 'max_air_temp', 'dewpoint_temp', 'relative_humidity', 'ghi', 'ghi10', 'ghi90', 'dni', 'dni10', 'dni90',
  'dhi', 'dhi10', 'dhi90', 'gti', 'gti10', 'gti90', 'clearsky_ghi', 'clearsky_dni', 'clearsky_dhi', 'clearsky_gti', 'cloud_opacity', 'cloud_opacity10', 'cloud_opacity90',
  'albedo', 'azimuth', 'zenith', 'wind_speed_10m', 'wind_speed_100m', 'wind_direction_10m', 'wind_direction_100m', 'wind_gust', 'precipitation_rate', 'snowfall_rate',
  'snow_depth', 'snow_water_equivalent', 'snow_soiling_rooftop', 'snow_soiling_ground', 'surface_pressure', 'precipitable_water', 'cape', 'weather_type', 'pm10', 'pm2.5'];

(async () => {
  // ── The requests ──
  const site = { latitude: 6.5, longitude: 3.4, capacity: 5, tilt: 30, azimuth: 180, loss_factor: 0.9, install_date: '2020-01-01' };
  const pv = solar.solcastPvUrl(site);
  assert.strictEqual(pv.pathname, '/data/forecast/rooftop_pv_power', 'the current endpoint, not /world_pv_power');
  assert.strictEqual(pv.searchParams.get('format'), 'json;version=3', 'the current response format');
  assert.strictEqual(pv.searchParams.get('output_parameters'), 'pv_power_rooftop,pv_power_rooftop10,pv_power_rooftop90');
  assert.strictEqual(pv.searchParams.get('capacity'), '5'); assert.strictEqual(pv.searchParams.get('install_date'), '2020-01-01');
  assert.strictEqual(pv.searchParams.get('hours'), '168'); assert.strictEqual(pv.searchParams.get('period'), 'PT30M');
  assert.ok(!/world_pv_power/.test(pv.href));
  const wx = solar.solcastWeatherUrl(site);
  assert.strictEqual(wx.pathname, '/data/forecast/radiation_and_weather');
  assert.strictEqual(wx.searchParams.get('format'), 'json;version=3');
  assert.deepStrictEqual(wx.searchParams.get('output_parameters').split(','), DOCUMENTED_WEATHER, 'every documented parameter is requested');
  assert.deepStrictEqual(solar.SOLCAST_WEATHER_PARAMS, DOCUMENTED_WEATHER);
  assert.ok(solar.SOLCAST_WEATHER_CORE.every(k => DOCUMENTED_WEATHER.includes(k)), 'the fallback set is a subset');
  assert.ok(!/KEY/.test(pv.href + wx.href), 'no key in the URL');
  assert.match(solar.solcastRooftopUrl('SITE').href, /rooftop_sites\/SITE\/forecasts\?format=json$/, 'the site endpoint is unchanged');
  console.log('ok - the current endpoints, format and every documented parameter');

  // ── Field names ──
  let p = solar.mapSolcastPeriod({ period_end: '2026-11-13T10:30:00+00:00', period: 'PT30M', pv_power_rooftop: 2.5, pv_power_rooftop10: 1.5, pv_power_rooftop90: 3.5 });
  assert.strictEqual(p.pv_estimate, 2.5); assert.strictEqual(p.pv_estimate10, 1.5); assert.strictEqual(p.pv_estimate90, 3.5);
  assert.strictEqual(p.pv_power_rooftop, 2.5, 'the new names stay too');
  p = solar.mapSolcastPeriod({ period_end: 'x', pv_estimate: 1, precipitation_rate: 0.4, cloud_opacity: 30, wind_speed_10m: 3, brand_new_field: 7 });
  assert.strictEqual(p.pv_estimate, 1, 'the legacy site response still works');
  assert.strictEqual(p.precip_rate, 0.4); assert.strictEqual(p.cloud_cover, 30); assert.strictEqual(p.brand_new_field, 7, 'unknown fields pass through');
  const w = solar.mapSolcastWeatherPeriod({ period_end: 'x', ghi: 500, precipitation_rate: 1 });
  assert.strictEqual(w.precip_rate, 1); assert.ok(!('pv_estimate' in w), 'no PV values made up for a weather period');
  console.log('ok - new and legacy field names');

  // ── Merging by period_end across the two time formats ──
  const endMs = Date.UTC(2026, 10, 13, 10, 30);
  const legacyEnd = new Date(endMs).toISOString().replace('Z', '0000Z').replace('.000', '.000');   // 2026-11-13T10:30:00.0000000Z style
  const v3End = '2026-11-13T10:30:00+00:00';
  const periods = [{ period_end: legacyEnd, period: 'PT30M', pv_estimate: 2 }, { period_end: '2026-11-13T11:00:00+00:00', pv_estimate: 3 }];
  const byEnd = new Map([[endMs, solar.mapSolcastWeatherPeriod({ period_end: v3End, ghi: 640, air_temp: 28, pv_estimate: 99 })]]);
  solar.mergeSolcastWeather(periods, byEnd);
  assert.strictEqual(periods[0].ghi, 640); assert.strictEqual(periods[0].air_temp, 28, 'matched on the instant, whatever the format');
  assert.strictEqual(periods[0].pv_estimate, 2, 'the PV value is never replaced');
  assert.strictEqual(periods[1].ghi, undefined, 'a period with no weather is left alone');
  console.log('ok - weather merged onto the forecast periods');

  // ── A day's weather ──
  const day = { date: 'd', total_kwh: 0, peak_kw: 0 };
  for (let i = 0; i < 48; i++) solar.accumulateDayWeather(day, { period: 'PT30M', air_temp: 25, min_air_temp: 18, max_air_temp: 31, precip_rate: 2, wind_speed_10m: i === 5 ? 9 : 3, wind_gust: i === 5 ? 14 : 5, cloud_opacity: i < 24 ? 20 : 60, ghi: 500, snowfall_rate: 0.5 });
  solar.finishDayWeather(day);
  assert.deepStrictEqual(day, { date: 'd', total_kwh: 0, peak_kw: 0, temp_min: 18, temp_max: 31, precip_mm: 48, wind_max: 9, wind_gust_max: 14, cloud_cover_avg: 40, ghi_kwh_m2: 12, snowfall_cm: 12 });
  const bare = { date: 'd' }; solar.accumulateDayWeather(bare, { period: 'PT30M', pv_estimate: 1 }); solar.finishDayWeather(bare);
  assert.deepStrictEqual(bare, { date: 'd' }, 'no weather in the forecast: no weather fields on the day');
  console.log('ok - the weather of a day');

  // ── The request budget ──
  const at = h => Date.UTC(2026, 10, 13, h, 0);
  setConfig('solcast_daily_limit', '10');
  assert.strictEqual(solar.solcastDailyLimit(), 10);
  setConfig('solcast_requests', JSON.stringify({ day: '2026-11-13', count: 0 }));
  assert.ok(solar.solcastBudgetAllows(1, at(0)), 'at midnight: 8 forecast refreshes ahead, one weather request still fits');
  setConfig('solcast_requests', JSON.stringify({ day: '2026-11-13', count: 2 }));
  assert.ok(!solar.solcastBudgetAllows(1, at(0)), 'two used, eight forecasts still due: no room');
  setConfig('solcast_requests', JSON.stringify({ day: '2026-11-13', count: 7 }));
  assert.ok(solar.solcastBudgetAllows(1, at(22)), 'late in the day only one forecast is due');
  setConfig('solcast_requests', JSON.stringify({ day: '2026-11-13', count: 9 }));
  assert.ok(!solar.solcastBudgetAllows(1, at(22)));
  assert.strictEqual(solar.solcastRequestsToday(Date.UTC(2026, 10, 14, 1)), 0, 'a new UTC day starts at zero');
  setConfig('solcast_daily_limit', '100'); assert.ok(solar.solcastBudgetAllows(1, at(0)), 'a bigger plan has room');
  setConfig('solcast_daily_limit', 'nonsense'); assert.strictEqual(solar.solcastDailyLimit(), 10, 'unset or invalid is the hobbyist limit');
  setConfig('solcast_daily_limit', '');
  console.log('ok - the request budget keeps room for the forecast');

  // ── The whole thing, against a stubbed Solcast ──
  const cfg = { forecast_enabled: 'true', solar_latitude: '6.5', solar_longitude: '3.4', solar_capacity_kwp: '5', solcast_api_key: 'TESTKEY', solcast_resource_id: '', solar_loss_factor: '0.9', solar_install_date: '2020-01-01', solar_tilt: '30', solar_azimuth: '180', solcast_weather: 'true', solcast_requests: '', solcast_daily_limit: '' };
  for (const [k, v] of Object.entries(cfg)) setConfig(k, v);
  const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
  const first = Math.ceil(Date.now() / 1800000) * 1800000;
  const ends = Array.from({ length: 96 }, (_, i) => first + i * 1800000);
  const pvBody = () => ({ forecasts: ends.map(e => ({ pv_power_rooftop: 2, pv_power_rooftop10: 1, pv_power_rooftop90: 3, period_end: iso(e), period: 'PT30M' })) });
  const wxBody = () => ({ forecasts: ends.map(e => ({ air_temp: 27.5, min_air_temp: 22, max_air_temp: 33, dewpoint_temp: 19, relative_humidity: 66, ghi: 600, ghi10: 400, ghi90: 750, dni: 700, dhi: 120, cloud_opacity: 25, wind_speed_10m: 4.2, wind_direction_10m: 225, wind_gust: 8, precipitation_rate: 0.3, surface_pressure: 1009, precipitable_water: 31, cape: 120, 'pm2.5': 18, pm10: 30, snow_depth: 0, period_end: iso(e), period: 'PT30M' })) });
  let calls = [], wxMode = 'ok';
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: opts && opts.headers && opts.headers.Authorization });
    if (u.pathname === '/data/forecast/rooftop_pv_power') return { ok: true, status: 200, json: async () => pvBody(), headers: { get: () => null } };
    if (u.pathname === '/data/forecast/radiation_and_weather') {
      if (wxMode === '403') return { ok: false, status: 403, text: async () => 'forbidden', headers: { get: () => null } };
      if (wxMode === '429') return { ok: false, status: 429, text: async () => '', headers: { get: h => (/retry-after/i.test(h) ? '7200' : null) } };
      if (wxMode === '400' && u.searchParams.get('output_parameters').split(',').length > solar.SOLCAST_WEATHER_CORE.length) return { ok: false, status: 400, text: async () => '{"errors":[{"field_name":"output_parameters"}]}', headers: { get: () => null } };
      return { ok: true, status: 200, json: async () => wxBody(), headers: { get: () => null } };
    }
    return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
  };
  const fresh = (mode = 'ok') => { solar.clearForecastCache(); solar.resetSolcastWeather(); wxMode = mode; calls = []; setConfig('solcast_requests', ''); };

  fresh();
  let r = await solar.getSolarForecast('auto');
  assert.strictEqual(r.source, 'solcast');
  assert.deepStrictEqual(calls.map(c => c.path), ['/data/forecast/rooftop_pv_power', '/data/forecast/radiation_and_weather'], 'one forecast request and one weather request');
  assert.ok(calls.every(c => c.auth === 'Bearer TESTKEY' && c.params.format === 'json;version=3'));
  assert.strictEqual(solar.solcastRequestsToday(), 2, 'both counted');
  const h = r.hourly.find(x => x.ghi != null);
  assert.ok(h, 'the hourly periods carry weather');
  assert.strictEqual(h.pv_estimate, 2, 'PV from the new field names'); assert.strictEqual(h.pv_estimate90, 3);
  assert.strictEqual(h.ghi, 600); assert.strictEqual(h.dni, 700); assert.strictEqual(h.wind_gust, 8); assert.strictEqual(h.precip_rate, 0.3); assert.strictEqual(h.cloud_cover, 25);
  const dayWx = r.daily.find(d => d.temp_max != null);
  assert.ok(dayWx && dayWx.temp_min === 22 && dayWx.temp_max === 33 && dayWx.wind_gust_max === 8 && dayWx.ghi_kwh_m2 > 0 && dayWx.precip_mm > 0, 'a day has its weather');
  assert.strictEqual(r.weather.temp, 27.5, 'the weather card shows Solcast\'s temperature'); assert.strictEqual(r.weather.wind_speed, 4.2); assert.strictEqual(r.weather.wind_compass, 'SW');
  assert.strictEqual(r.weather.pressure, 1009); assert.strictEqual(r.weather.ghi, 600); assert.strictEqual(r.weather_source, 'solcast');
  assert.strictEqual(r.weather.solcast.dni, 700); assert.strictEqual(r.weather.solcast.dewpoint_temp, 19); assert.strictEqual(r.weather.solcast.pm2_5, 18); assert.strictEqual(r.weather.solcast.cape, 120);
  flushMetrics();
  const latest = getDb().prepare("SELECT metric, value, unit FROM latest_metrics WHERE metric LIKE 'solcast_%'").all();
  const byName = Object.fromEntries(latest.map(x => [x.metric, x]));
  assert.strictEqual(byName.solcast_ghi.value, 600); assert.strictEqual(byName.solcast_ghi.unit, 'W/m²');
  assert.strictEqual(byName.solcast_air_temp.value, 27.5); assert.strictEqual(byName.solcast_pm2_5.value, 18); assert.strictEqual(byName.solcast_pv_estimate.unit, 'kW');
  assert.ok(Object.keys(byName).length >= 20, 'one metric per value: ' + Object.keys(byName).length);
  console.log('ok - forecast, weather, days, card and metrics from the two requests');

  // The weather is fetched with the forecast, not again from a cached answer
  calls = [];
  await solar.getSolarForecast('auto');
  assert.strictEqual(calls.length, 0, 'cached for three hours');

  // The weather request failing never touches the forecast
  for (const [mode, label] of [['403', 'not on the plan'], ['429', 'quota'], ['400', 'rejected list']]) {
    fresh(mode);
    r = await solar.getSolarForecast('auto');
    assert.strictEqual(r.source, 'solcast', label + ': the forecast is fine');
    assert.ok(r.hourly.length > 0 && r.hourly[0].pv_estimate === 2, label + ': PV values there');
    if (mode === '400') {
      const wxCalls = calls.filter(c => c.path.endsWith('radiation_and_weather'));
      assert.strictEqual(wxCalls.length, 2, 'a rejected list is retried once with the core parameters');
      assert.deepStrictEqual(wxCalls[1].params.output_parameters.split(','), solar.SOLCAST_WEATHER_CORE);
      assert.strictEqual(r.hourly.find(x => x.ghi != null).ghi, 600, 'and the weather arrives');
      continue;
    }
    assert.strictEqual(r.hourly.find(x => x.ghi != null), undefined, label + ': no weather');
    calls = [];
    // The next refresh: the weather is not tried again while it is off (until tomorrow, or midnight UTC, or the Retry-After).
    await solar.attachSolcastWeatherData(r.hourly.map(x => ({ ...x })), { latitude: 6.5, longitude: 3.4, tilt: 30, azimuth: 180 }, 'TESTKEY', 1, Date.now() + 3600000);
    assert.ok(!calls.some(c => c.path.endsWith('radiation_and_weather')), label + ': not retried straight away');
  }
  console.log('ok - the weather request failing never touches the forecast');

  // Off by setting, and out of budget
  fresh(); setConfig('solcast_weather', 'false');
  await solar.getSolarForecast('auto');
  assert.deepStrictEqual(calls.map(c => c.path), ['/data/forecast/rooftop_pv_power'], 'switched off: no weather request');
  setConfig('solcast_weather', 'true');
  fresh(); setConfig('solcast_requests', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 9 }));
  await solar.getSolarForecast('auto');
  assert.ok(!calls.some(c => c.path.endsWith('radiation_and_weather')), 'no room in the day\'s budget: no weather request');
  console.log('ok - switched off, and out of budget');

  // The settings test uses the new endpoint too
  fresh(); calls = [];
  const t = await solar.testForecast({ lat: 6.5, lon: 3.4, capacity: 5, tilt: 30, azimuth: 180, api_key: 'TESTKEY' });
  assert.strictEqual(t.source, 'solcast'); assert.strictEqual(calls[0].path, '/data/forecast/rooftop_pv_power');
  console.log('ok - the settings test');

  // ── Wiring ──
  const srv = read('server.js').slice(read('server.js').indexOf("app.post('/api/settings/solar'"));
  assert.ok(srv.includes("'solcast_daily_limit', 'solcast_weather'"), 'the solar settings route saves them');
  assert.ok(solar.FORECAST_CACHE_KEYS.includes('solcast_weather') && solar.FORECAST_CACHE_KEYS.includes('solcast_daily_limit'));
  const { validateNumericConfig } = require(path.join(REPO, 'modules/configValidation'));
  assert.strictEqual(validateNumericConfig({ solcast_daily_limit: '10' }), null);
  assert.match(validateNumericConfig({ solcast_daily_limit: '0' }), /solcast_daily_limit/); assert.match(validateNumericConfig({ solcast_daily_limit: 'x' }), /number/);
  const html = read('public/settings.html');
  assert.ok(/name="solcast_weather"/.test(html) && /name="solcast_daily_limit"/.test(html), 'the settings page has both');
  const card = read('public/js/components/weatherBlock.js');
  for (const label of ['Direct sun', 'Diffuse sun', 'Dew point', 'PM2.5']) assert.ok(card.includes(label), label + ' on the weather card');
  console.log('ok - settings and weather card wiring');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
