#!/usr/bin/env node
/**
 * test/solar-forecast-s5.test.js — issue #127 S5 (rest: resolver fixtures).
 *
 * Covers (plain node, no framework, no network, no real DB):
 *   - T5 full rest_map (temp/humidity/wind/precip/cloud/ghi/description/
 *     pv_estimate -> weather values match, source_label = source.name,
 *     hourly [] and 3 all-null daily stubs)
 *   - T6 temp-only map (temp renders, rest null, no throw)
 *   - unknown name -> { error: 'Source unavailable: rest:<name>' }
 *   - disabled source (!enabled) -> error
 *   - source without url -> error
 *   - absent metric -> null, not error
 *   - non-string map values ignored (-> alias / null)
 *   - malformed external_sources JSON -> error, no throw
 *   - case-sensitivity (different case -> error)
 *
 * DB/network isolation: modules/database.js is pre-seeded in the require
 * cache BEFORE modules/solar.js loads, so getConfig/getDb are stubs and the
 * repo's real DB is never touched.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---- Stub modules/database.js in the require cache before solar.js loads ----
const SRC_FULL = { name: 'roof-rest', enabled: true, url: 'http://rest.local/data' };
const SRC_DISABLED = { name: 'off-src', enabled: false, url: 'http://rest.local/off' };
const SRC_NOURL = { name: 'nourl-src', enabled: true };
const SRC_CASE = { name: 'Roof-Rest', enabled: true, url: 'http://rest.local/case' };

const cfg = {
  forecast_enabled: 'true',
  solar_capacity_kwp: '5',
  external_sources: JSON.stringify([SRC_FULL, SRC_DISABLED, SRC_NOURL, SRC_CASE])
};

// latest_metrics rows backing the T5/T6 fixtures.
let metricRows = [];
const dbId = require.resolve('../modules/database');
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: {
    getConfig: (k) => cfg[k],
    flushMetrics: () => 0,
    getDb: () => ({
      prepare: () => ({
        all: () => metricRows,
        get: () => undefined
      })
    })
  }
};

const solar = require('../modules/solar');

function setMetrics(rows) { metricRows = rows; }
function numRows(obj) {
  return Object.entries(obj).map(([metric, value]) => ({ metric, value, value_text: null }));
}

const FULL_MAP = {
  temp: 'm_temp', humidity: 'm_hum', wind: 'm_wind', precip: 'm_precip',
  cloud: 'm_cloud', ghi: 'm_ghi', description: 'm_desc', pv_estimate: 'm_pv'
};
const FULL_ROWS = [
  { metric: 'm_temp', value: 27.5, value_text: null },
  { metric: 'm_hum', value: 55, value_text: null },
  { metric: 'm_wind', value: 3.2, value_text: null },
  { metric: 'm_precip', value: 0.1, value_text: null },
  { metric: 'm_cloud', value: 42, value_text: null },
  { metric: 'm_ghi', value: 812, value_text: null },
  { metric: 'm_desc', value: 0, value_text: 'Partly cloudy' },
  { metric: 'm_pv', value: 2.75, value_text: null }
];

// ---- Export surface (static) ----
check('exports: resolveRestSource + REST_DEFAULT_ALIASES present', () => {
  assert.strictEqual(typeof solar.resolveRestSource, 'function');
  assert.ok(solar.REST_DEFAULT_ALIASES && typeof solar.REST_DEFAULT_ALIASES === 'object');
  assert.deepStrictEqual(solar.REST_DEFAULT_ALIASES.temp, ['temp', 'air_temp', 'temperature']);
});

// ---- T5: full map ----
check('T5: full map weather values match', () => {
  setMetrics(FULL_ROWS);
  const r = solar.resolveRestSource('roof-rest', FULL_MAP);
  assert.ok(!r.error, `unexpected error: ${JSON.stringify(r)}`);
  assert.strictEqual(r.source, 'rest:roof-rest');
  assert.strictEqual(r.source_label, 'roof-rest');
  assert.strictEqual(r.weather_source, 'rest:roof-rest');
  assert.strictEqual(r.weather.temp, 27.5);
  assert.strictEqual(r.weather.humidity, 55);
  assert.strictEqual(r.weather.wind, 3.2);
  assert.strictEqual(r.weather.precip, 0.1);
  assert.strictEqual(r.weather.cloud, 42);
  assert.strictEqual(r.weather.ghi, 812);
  assert.strictEqual(r.weather.description, 'Partly cloudy');
  assert.strictEqual(r.pv_estimate, 2.75);
});
check('T5: hourly [] and 3 all-null daily stubs', () => {
  setMetrics(FULL_ROWS);
  const r = solar.resolveRestSource('roof-rest', FULL_MAP);
  assert.deepStrictEqual(r.hourly, []);
  assert.ok(Array.isArray(r.daily) && r.daily.length === 3, `daily len: ${JSON.stringify(r.daily)}`);
  for (const d of r.daily) {
    assert.strictEqual(d.total_kwh, null);
    assert.strictEqual(d.peak_kw, null);
    assert.strictEqual(d.source, 'rest:roof-rest');
  }
});

// ---- T6: temp-only ----
check('T6: temp-only map renders temp, rest null, no throw', () => {
  setMetrics([{ metric: 'm_temp', value: 21.5, value_text: null }]);
  const r = solar.resolveRestSource('roof-rest', { temp: 'm_temp' });
  assert.ok(!r.error, `unexpected error: ${JSON.stringify(r)}`);
  assert.strictEqual(r.weather.temp, 21.5);
  assert.strictEqual(r.weather.humidity, null);
  assert.strictEqual(r.weather.wind, null);
  assert.strictEqual(r.weather.precip, null);
  assert.strictEqual(r.weather.cloud, null);
  assert.strictEqual(r.weather.ghi, null);
  assert.strictEqual(r.weather.description, null);
  assert.strictEqual(r.pv_estimate, null);
});

// ---- Error cases (sync resolver) ----
check('unknown name -> Source unavailable error', () => {
  setMetrics(FULL_ROWS);
  const r = solar.resolveRestSource('nope-missing', FULL_MAP);
  assert.deepStrictEqual(r, { error: 'Source unavailable: rest:nope-missing' });
});
check('disabled source -> error', () => {
  setMetrics(FULL_ROWS);
  const r = solar.resolveRestSource('off-src', FULL_MAP);
  assert.deepStrictEqual(r, { error: 'Source unavailable: rest:off-src' });
});
check('source without url -> error', () => {
  setMetrics(FULL_ROWS);
  const r = solar.resolveRestSource('nourl-src', FULL_MAP);
  assert.deepStrictEqual(r, { error: 'Source unavailable: rest:nourl-src' });
});
check('absent metric -> null, not error', () => {
  // Full map given but only temp present in latest_metrics.
  setMetrics([{ metric: 'm_temp', value: 19, value_text: null }]);
  const r = solar.resolveRestSource('roof-rest', FULL_MAP);
  assert.ok(!r.error, `unexpected error: ${JSON.stringify(r)}`);
  assert.strictEqual(r.weather.temp, 19);
  assert.strictEqual(r.weather.humidity, null);
  assert.strictEqual(r.weather.wind, null);
  assert.strictEqual(r.pv_estimate, null);
});
check('non-string map values ignored (-> alias / null)', () => {
  // Aliased rows present; garbage map values must fall back to aliases.
  setMetrics(numRows({ temp: 30, humidity: 44 }));
  const r = solar.resolveRestSource('roof-rest', { temp: 123, humidity: null, wind: ['x'], ghi: { a: 1 } });
  assert.ok(!r.error, `unexpected error: ${JSON.stringify(r)}`);
  assert.strictEqual(r.weather.temp, 30);
  assert.strictEqual(r.weather.humidity, 44);
  assert.strictEqual(r.weather.wind, null);
  assert.strictEqual(r.weather.ghi, null);
});
check('malformed external_sources JSON -> error, no throw', () => {
  const prev = cfg.external_sources;
  cfg.external_sources = '{not-json';
  setMetrics(FULL_ROWS);
  let r;
  assert.doesNotThrow(() => { r = solar.resolveRestSource('roof-rest', FULL_MAP); });
  assert.deepStrictEqual(r, { error: 'Source unavailable: rest:roof-rest' });
  cfg.external_sources = prev;
});
check('case-sensitivity: different case -> error', () => {
  setMetrics(FULL_ROWS);
  // Exact-case hit works ('Roof-Rest' is a distinct registered source).
  const hit = solar.resolveRestSource('Roof-Rest', FULL_MAP);
  assert.ok(!hit.error, `unexpected error: ${JSON.stringify(hit)}`);
  assert.strictEqual(hit.source_label, 'Roof-Rest');
  // Wrong-case lookup of the lowercase source against a registry that only
  // has the mixed-case name must fail.
  const prev = cfg.external_sources;
  cfg.external_sources = JSON.stringify([SRC_CASE]);
  const miss = solar.resolveRestSource('roof-rest', FULL_MAP);
  assert.deepStrictEqual(miss, { error: 'Source unavailable: rest:roof-rest' });
  cfg.external_sources = prev;
});

(async () => {
  // ---- getSolarForecast rest: wiring ----
  setMetrics(FULL_ROWS);
  const rf = await solar.getSolarForecast('rest:roof-rest', FULL_MAP);
  assert.ok(!rf.error, `unexpected error: ${JSON.stringify(rf)}`);
  assert.strictEqual(rf.source, 'rest:roof-rest');
  assert.strictEqual(rf.source_label, 'roof-rest');
  assert.strictEqual(rf.weather.temp, 27.5);
  assert.deepStrictEqual(rf.hourly, []);

  setMetrics(FULL_ROWS);
  const ru = await solar.getSolarForecast('rest:nope-missing', FULL_MAP);
  assert.deepStrictEqual(ru, { error: 'Source unavailable: rest:nope-missing' });

  setMetrics(FULL_ROWS);
  const rd = await solar.getSolarForecast('rest:off-src', FULL_MAP);
  assert.deepStrictEqual(rd, { error: 'Source unavailable: rest:off-src' });

  passed += 3; // three async getSolarForecast assertions above
  console.log('ok - getSolarForecast rest: full map + unknown/disabled -> error');

  console.log(`\nPASS solar-forecast-s5: ${passed} checks`);
})().catch((e) => {
  console.error(`FAIL: ${e.stack || e}`);
  process.exit(1);
});
