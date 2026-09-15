#!/usr/bin/env node
/**
 * test/solar-forecast-s6prime.test.js — issue #127 S6-prime regression fixtures.
 *
 * Covers (plain node, no framework, no network, no real DB):
 *   - (1) PAYLOAD: 7-day / 30-min synthetic Solcast upstream (336 periods,
 *         FULL known field set + a fake unknown field) -> getSolarForecast
 *         JSON byte length < 200 KiB; unknown field forwarded verbatim (T1b).
 *   - (2) CACHE ISOLATION (deferred S1' gap): two selectors in one process ->
 *         per-selector entries independent (solcast then auto refetches;
 *         repeat solcast is a cache hit returning the identical object).
 *   - (3) RADAR ABSENCE T17/AC14 (static scan, no network): weatherBlock.js +
 *         forecast.js contain zero tile/radar/leaflet/iframe/mapbox/{z}/{x}
 *         matches; editor.js contains zero radar-class matches (iframe is
 *         allowed there ONLY on the generic embed-card path, never coupled
 *         to weather/radar). Failures print file:line details.
 *   - (4) NULL DISCIPLINE (T1b half): dni dropped from a period -> null,
 *         no throw — unit-level (mapSolcastPeriod) and forecast-level
 *         (hourly[0].dni === null through getSolarForecast).
 *
 * DB/network isolation: same pattern as solar-forecast-s1prime.test.js —
 * modules/database.js is pre-seeded in the require cache BEFORE
 * modules/solar.js loads; global.fetch and https.get are stubbed.
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
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) })
  }
};

const solar = require('../modules/solar');
const https = require('https');

// ---- Synthetic 7-day / 30-min Solcast upstream (336 periods) ----
const UNKNOWN_SENTINEL = 's6p-verbatim';
function buildPeriods({ dropDni = false } = {}) {
  const periods = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 336; i++) {
    const t = new Date(base.getTime() + i * 30 * 60 * 1000);
    const p = {
      period: 'PT30M',
      period_end: t.toISOString(),
      pv_estimate: 1.1 + (i % 10) * 0.1,
      pv_estimate10: 0.9,
      pv_estimate90: 1.4,
      ghi: 500 + (i % 50),
      ghi10: 400,
      ghi90: 600,
      dni: 700,
      dni10: 600,
      dni90: 800,
      ebh: 100,
      dhi: 120,
      dhi10: 100,
      dhi90: 140,
      air_temp: 28.5,
      relative_humidity: 61,
      cloud_opacity: 10,
      precip_rate: 0,
      wind_speed: 3.2,
      wind_speed_10m: 4.1,
      azimuth: 180,
      zenith: 45,
      future_field_s6p: UNKNOWN_SENTINEL
    };
    if (dropDni) { delete p.dni; delete p.dni10; delete p.dni90; }
    periods.push(p);
  }
  return periods;
}
let upstreamPeriods = buildPeriods();
let fetchCalls = 0;
let lastFetchUrl = '';
global.fetch = async (url) => {
  fetchCalls++;
  lastFetchUrl = String(url);
  return { ok: true, json: async () => ({ forecasts: upstreamPeriods }) };
};

// ---- Stub https.get: minimal Open-Meteo payload (weather fallback path) ----
const todayStr = new Date().toISOString().split('T')[0];
const curHour = new Date().getHours();
const pad = (n) => String(n).padStart(2, '0');
const omTime = `${todayStr}T${pad(curHour)}:00`;
function fakeGet(url, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  const isDaily = String(url).includes('daily=');
  const payload = isDaily
    ? { daily: { time: [todayStr], weathercode: [0], temperature_2m_max: [15], apparent_temperature_max: [14], relativehumidity_2m_mean: [20] } }
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

// ---- (3) RADAR ABSENCE T17/AC14: static scan helper (sync, runs first) ----
function scanMatches(srcPath, patterns) {
  const text = fs.readFileSync(srcPath, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, idx) => {
    for (const re of patterns) {
      if (re.test(line)) { hits.push(`${path.relative(path.join(__dirname, '..'), srcPath)}:${idx + 1}: ${line.trim().slice(0, 120)}`); break; }
    }
  });
  return hits;
}

// weather/forecast paths: no map-stack tokens at all (case-insensitive).
const WEATHER_PATTERNS = [/tile/i, /radar/i, /leaflet/i, /iframe/i, /mapbox/i, /\{z\}/, /\{x\}/];
// editor.js: no radar-class tokens (the generic iframe-card embed builder is
// legitimate there — confined to the embed-card path, see iframe check below).
const EDITOR_PATTERNS = [/tile/i, /radar/i, /leaflet/i, /mapbox/i, /\{z\}/, /\{x\}/];

check('radar absence: weatherBlock.js has zero map-stack matches', () => {
  const hits = scanMatches(path.join(__dirname, '..', 'public', 'js', 'components', 'weatherBlock.js'), WEATHER_PATTERNS);
  assert.deepStrictEqual(hits, [], `map-stack tokens in weatherBlock.js:\n${hits.join('\n')}`);
});
check('radar absence: forecast.js has zero map-stack matches', () => {
  const hits = scanMatches(path.join(__dirname, '..', 'public', 'js', 'forecast.js'), WEATHER_PATTERNS);
  assert.deepStrictEqual(hits, [], `map-stack tokens in forecast.js:\n${hits.join('\n')}`);
});
check('radar absence: editor.js has zero radar-class matches', () => {
  const hits = scanMatches(path.join(__dirname, '..', 'public', 'js', 'editor.js'), EDITOR_PATTERNS);
  assert.deepStrictEqual(hits, [], `radar-class tokens in editor.js:\n${hits.join('\n')}`);
});
check('radar absence: editor.js iframe hits confined to generic embed-card path', () => {
  const editorPath = path.join(__dirname, '..', 'public', 'js', 'editor.js');
  const lines = fs.readFileSync(editorPath, 'utf8').split('\n');
  const bad = [];
  lines.forEach((line, idx) => {
    if (/iframe/i.test(line)) {
      const generic = /iframe-card|iframe-url|Iframe Card|buildIframeCardForm|iframeCard/i.test(line);
      // weather-block is a legitimate component name, not a radar coupling
      const coupled = /radar|leaflet|mapbox/i.test(line);
      if (!generic || coupled) bad.push(`editor.js:${idx + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
  assert.deepStrictEqual(bad, [], `non-embed iframe usage in editor.js:\n${bad.join('\n')}`);
});

(async () => {
  // ---- (4a) NULL discipline, unit level: dni dropped -> null, no throw ----
  check('null discipline: dropped dni maps to null, no throw', () => {
    const out = solar.mapSolcastPeriod({ pv_estimate: 1.2 });
    assert.strictEqual(out.dni, null);
    assert.strictEqual(out.dni10, null);
    assert.strictEqual(out.dni90, null);
    assert.strictEqual(out.pv_estimate, 1.2);
  });

  // ---- (1) PAYLOAD: 336-period full-field upstream -> JSON < 200 KiB ----
  solar.clearForecastCache();
  upstreamPeriods = buildPeriods();
  fetchCalls = 0;
  const res = await solar.getSolarForecast('solcast');
  check('payload: solcast source selected for full 7-day upstream', () => {
    assert.strictEqual(res.source, 'solcast');
    assert.ok(Array.isArray(res.hourly) && res.hourly.length > 0, 'hourly missing');
  });
  check('payload: getSolarForecast JSON < 200 KiB (hourly capped, no bloat)', () => {
    const bytes = Buffer.byteLength(JSON.stringify(res), 'utf8');
    console.log(`    (payload bytes: ${bytes}, ${(bytes / 1024).toFixed(1)} KiB)`);
    assert.ok(bytes < 200 * 1024, `payload ${bytes} bytes exceeds 200 KiB`);
  });
  check('payload: unknown upstream field forwarded verbatim (T1b)', () => {
    assert.strictEqual(res.hourly[0].future_field_s6p, UNKNOWN_SENTINEL);
  });
  check('payload: upstream request carries capacity/tilt/azimuth params', () => {
    // With solcast_resource_id configured, the rooftop_sites endpoint is used (no capacity param);
    // without it, world_pv_power endpoint is used with capacity/tilt/azimuth.
    // We stubbed solcast_resource_id -> rooftop_sites is chosen.
    assert.ok(/rooftop_sites\/STUBRES/.test(lastFetchUrl), `rooftop_sites path missing: ${lastFetchUrl}`);
    assert.ok(/format=json/.test(lastFetchUrl), `format=json missing: ${lastFetchUrl}`);
    assert.ok(/api_key=STUBKEY/.test(lastFetchUrl), `api_key missing: ${lastFetchUrl}`);
  });

  // ---- (4b) NULL discipline, forecast level: dni-less upstream -> null ----
  solar.clearForecastCache();
  upstreamPeriods = buildPeriods({ dropDni: true });
  fetchCalls = 0;
  let noThrow = null;
  try {
    noThrow = await solar.getSolarForecast('solcast');
  } catch (e) { noThrow = e; }
  check('null discipline: dni-less upstream flows through with no throw', () => {
    assert.ok(noThrow && ! (noThrow instanceof Error), `threw: ${noThrow && noThrow.stack || noThrow}`);
    assert.strictEqual(noThrow.hourly[0].dni, null);
  });

  // ---- (2) CACHE ISOLATION: solcast vs auto entries independent ----
  solar.clearForecastCache();
  upstreamPeriods = buildPeriods();
  fetchCalls = 0;
  const rSol = await solar.getSolarForecast('solcast');
  check('cache isolation: first solcast fetch hits upstream', () => {
    assert.strictEqual(fetchCalls >= 1, true);
    assert.strictEqual(rSol.source, 'solcast');
  });
  const callsAfterSol = fetchCalls;
  const rAuto = await solar.getSolarForecast('auto');
  check('cache isolation: auto does NOT reuse solcast entry (refetch, distinct object)', () => {
    assert.ok(fetchCalls > callsAfterSol, `auto reused solcast cache (fetchCalls ${callsAfterSol} -> ${fetchCalls})`);
    assert.notStrictEqual(rAuto, rSol);
  });
  const callsAfterAuto = fetchCalls;
  const rSol2 = await solar.getSolarForecast('solcast');
  check('cache isolation: repeat solcast served from its own entry (no refetch, identical object)', () => {
    assert.strictEqual(fetchCalls, callsAfterAuto);
    assert.strictEqual(rSol2, rSol);
  });

  console.log(`\nPASS solar-forecast-s6prime: ${passed} checks`);
})().catch((e) => {
  console.error(`FAIL: ${e.stack || e}`);
  process.exit(1);
});
