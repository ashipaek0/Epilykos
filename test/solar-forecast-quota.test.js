#!/usr/bin/env node
/**
 * test/solar-forecast-quota.test.js — issue #127 Solcast quota-hardening fixtures
 * (spec items 14-16). Plain node, no framework, no network, no real DB.
 *
 * Covers:
 *   (a) 60 rapid getSolarForecast('solcast') against a failing upstream
 *       (ok:false, status 500) -> upstream fetch hit EXACTLY once; every
 *       cache-served call returns byte-identical error text.
 *   (b) clearForecastCache() + immediate re-call yields exactly 1 more
 *       upstream hit; 429 + Retry-After: second immediate call makes no fetch.
 *   (c) Isolation: with a solcast negative entry present,
 *       getSolarForecast('open-meteo') still returns source open-meteo and
 *       still touches https (quota state never blocks the OM path).
 *   (d) Retry-After honored: computeNegativeCacheEntry('e',429,'3600') spans
 *       ~3600s; ('e',429,'99999999') is capped at SOLCAST_NEGATIVE_TTL_MAX_MS.
 *
 * DB/network isolation: modules/database.js is pre-seeded in the require
 * cache BEFORE modules/solar.js loads (same pattern as
 * test/solar-forecast-s6prime.test.js lines 42-64); global.fetch and
 * https.get are stubbed.
 *
 * NOTE on cfg: solcast_resource_id is intentionally left EMPTY here. With a
 * resource id set, one logical upstream attempt fires TWO fetches (rooftop
 * path fails -> world_pv_power fallback fires), so "exactly once" is only
 * well-defined on the single world_pv_power path.
 *
 * NOTE on first-call error text: the live failure itself returns the generic
 * { error: 'Solcast unavailable' } (solar.js getSolarForecast tail), while
 * subsequent calls are served from the negative cache via
 * buildCachedErrorResponse with the specific upstream text. The identity
 * assertion therefore covers the 59 cache-served calls.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const EventEmitter = require('events');

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
  solcast_resource_id: '',
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

// ---- Stub fetch: switchable failing-upstream modes ----
let fetchMode = 'http500'; // 'http500' | 'http429'
let fetchCalls = 0;
global.fetch = async () => {
  fetchCalls++;
  if (fetchMode === 'http429') {
    return { ok: false, status: 429, headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? '3600' : null) } };
  }
  return { ok: false, status: 500, headers: { get: () => null } };
};

// ---- Stub https.get: minimal Open-Meteo payload (copied pattern from s6prime) ----
let httpsCalls = 0;
// Local date: forecast days follow the process time zone (modules/localTime).
const todayStr = require('../modules/localTime').localDateString();
const curHour = new Date().getHours();
const pad = (n) => String(n).padStart(2, '0');
const omTime = `${todayStr}T${pad(curHour)}:00`;
const { openMeteoPayload } = require('./open-meteo-fixture');
function fakeGet(url, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  httpsCalls++;
  const payload = openMeteoPayload();
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
  // ---- constants: quota-hardening TTL/gate values ----
  check('constants: gate and TTL values as specified', () => {
    assert.strictEqual(solar.SOLCAST_UPSTREAM_GATE_MS, 3600000);
    assert.strictEqual(solar.SOLCAST_NEGATIVE_TTL_TRANSPORT_MS, 1800000);
    assert.strictEqual(solar.SOLCAST_NEGATIVE_TTL_429_BASE_MS, 7200000);
    assert.strictEqual(solar.SOLCAST_NEGATIVE_TTL_MAX_MS, 21600000);
  });

  // ---- (a) 60 rapid solcast calls vs failing upstream: exactly 1 fetch ----
  fetchMode = 'http500';
  solar.clearForecastCache();
  fetchCalls = 0;
  const errors = [];
  for (let i = 0; i < 60; i++) {
    const r = await solar.getSolarForecast('solcast');
    errors.push(r && r.error);
  }
  check('quota (a): 60 rapid failing solcast calls hit upstream EXACTLY once', () => {
    assert.strictEqual(fetchCalls, 1, `expected 1 upstream fetch, saw ${fetchCalls}`);
  });
  check('quota (a): all 60 calls return an error', () => {
    assert.ok(errors.every((e) => typeof e === 'string' && e.length > 0), 'some calls lacked error text');
  });
  check('quota (a): all 59 cache-served calls return identical error text', () => {
    const tail = errors.slice(1);
    assert.ok(tail.every((e) => e === tail[0]), `divergent cached error texts: ${JSON.stringify(errors.slice(0, 3))}`);
  });

  // ---- (b1) clearForecastCache + immediate re-call: exactly 1 more hit ----
  const beforeRe = fetchCalls;
  solar.clearForecastCache();
  const rRe = await solar.getSolarForecast('solcast');
  check('quota (b): clearForecastCache + immediate re-call yields exactly 1 more upstream hit', () => {
    assert.strictEqual(fetchCalls, beforeRe + 1, `expected 1 more fetch, saw ${fetchCalls - beforeRe}`);
    assert.ok(rRe && typeof rRe.error === 'string', 're-call should still error against failing upstream');
  });

  // ---- gate helper semantics: attempt recorded -> gate closed; clear resets ----
  check('gate: canAttemptSolcastUpstream false right after an upstream attempt', () => {
    assert.strictEqual(solar.canAttemptSolcastUpstream(), false);
  });
  check('gate: clearSolcastNegativeCache does NOT reopen the upstream gate', () => {
    solar.clearSolcastNegativeCache('solcast');
    assert.strictEqual(solar.canAttemptSolcastUpstream(), false);
  });
  check('gate: clearForecastCache reopens the upstream gate', () => {
    solar.clearForecastCache();
    assert.strictEqual(solar.canAttemptSolcastUpstream(), true);
  });

  // ---- (b2) 429 + Retry-After: second immediate call makes no fetch ----
  fetchMode = 'http429';
  solar.clearForecastCache();
  fetchCalls = 0;
  const r429a = await solar.getSolarForecast('solcast');
  const afterFirst429 = fetchCalls;
  const r429b = await solar.getSolarForecast('solcast');
  check('quota (b): 429 first call hits upstream once', () => {
    assert.strictEqual(afterFirst429, 1, `expected 1 upstream fetch, saw ${afterFirst429}`);
    assert.ok(r429a && typeof r429a.error === 'string');
  });
  check('quota (b): 429 second immediate call makes no fetch (negative-cached)', () => {
    assert.strictEqual(fetchCalls, afterFirst429, `expected no further fetch, saw ${fetchCalls - afterFirst429} more`);
    assert.ok(r429b && typeof r429b.error === 'string');
    assert.ok(/429/.test(r429b.error), `expected 429 cached text, got: ${r429b.error}`);
    assert.strictEqual(r429b.cached_error, true);
  });

  // ---- (c) isolation: solcast negative entry must not block open-meteo ----
  // (solcast negative entry for 429 currently present from (b2).)
  const fetchBeforeOM = fetchCalls;
  const httpsBeforeOM = httpsCalls;
  const rOM = await solar.getSolarForecast('open-meteo');
  check('isolation (c): open-meteo still returns source open-meteo with solcast negative entry present', () => {
    assert.strictEqual(rOM.source, 'open-meteo', `unexpected source: ${JSON.stringify(rOM).slice(0, 160)}`);
  });
  check('isolation (c): open-meteo path still touches https', () => {
    assert.ok(httpsCalls > httpsBeforeOM, 'https.get was not touched by the open-meteo call');
  });
  check('isolation (c): open-meteo call makes no solcast upstream fetch', () => {
    assert.strictEqual(fetchCalls, fetchBeforeOM, 'open-meteo call touched the solcast fetch path');
  });

  // ---- (d) Retry-After honored + capped ----
  check('retry-after (d): 429 + Retry-After 3600 -> retryAt-firstFailure == 3600000ms', () => {
    const e = solar.computeNegativeCacheEntry('e', 429, '3600');
    assert.strictEqual(e.retryAt - e.firstFailure, 3600000);
  });
  check('retry-after (d): 429 + huge Retry-After capped at 21600000ms', () => {
    const e = solar.computeNegativeCacheEntry('e', 429, '99999999');
    assert.ok(e.retryAt - e.firstFailure <= 21600000, `span ${e.retryAt - e.firstFailure} exceeds cap`);
  });
  check('negative-cache validity helper: fresh entry valid, expired entry not', () => {
    const e = solar.computeNegativeCacheEntry('e', 500, null);
    assert.strictEqual(e.retryAt - e.firstFailure, 1800000);
    assert.ok(solar.isNegativeCacheValid(e, Date.now()));
    assert.ok(!solar.isNegativeCacheValid({ retryAt: Date.now() - 1 }, Date.now()));
  });

  console.log(`\nPASS solar-forecast-quota: ${passed} checks`);
})().catch((e) => {
  console.error(`FAIL: ${e.stack || e}`);
  process.exit(1);
});
