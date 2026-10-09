'use strict';
const checks = require('./_checks');

const assert = require('assert');
const { localDateString } = require('../modules/localTime');

const cfg = {
  forecast_enabled: 'true', solar_latitude: '6.5', solar_longitude: '3.4',
  solar_capacity_kwp: '5', solcast_api_key: 'STUBKEY', solcast_resource_id: 'STUBRES',
  solar_loss_factor: '0.9', solar_install_date: '2020-01-01'
};
const dbId = require.resolve('../modules/database');
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: {
    getConfig: (key) => cfg[key], setConfig: (key, value) => { cfg[key] = String(value); },
    flushMetrics: () => 0,
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) })
  }
};

const solar = require('../modules/solar');
let fetchCalls = 0;
const base = new Date();
base.setHours(0, 0, 0, 0);
const periods = [
  { period_end: new Date(base.getTime() + 10 * 60 * 60 * 1000).toISOString(), period: 'PT30M', pv_estimate: 2 },
  { period_end: new Date(base.getTime() + 11 * 60 * 60 * 1000).toISOString(), period: 'PT30M', pv_estimate: 3 },
  { period_end: 'not-a-timestamp', period: 'PT30M', pv_estimate: 4 }
];
global.fetch = async () => {
  fetchCalls++;
  return { ok: true, json: async () => ({ forecasts: periods }) };
};

(async () => {
  solar.clearForecastCache();
  const first = await solar.getSolarForecast('solcast');
  assert.strictEqual(first.server_today, localDateString());
  assert.strictEqual(Object.prototype.hasOwnProperty.call(first, 'timezone'), false);
  assert.strictEqual(first.hourly[0].date, localDateString(new Date(first.hourly[0].period_end)));
  assert.strictEqual(first.hourly[1].date, localDateString(new Date(first.hourly[1].period_end)));
  assert.strictEqual(first.hourly[2].date, null, 'invalid timestamps must not use their apparent/raw date');
  assert.deepStrictEqual(first.hourly.map((row) => row.energy_kwh), [1, 1.5, 2]);
  assert.strictEqual(first.hourly[0].pv_estimate, 2);
  assert.strictEqual(first.source, 'solcast');
  assert.strictEqual(first.source_label, 'Solcast');
  assert.deepStrictEqual(first.daily.map((day) => day.date), [localDateString(), 'not-a-timestamp'], 'existing daily labels remain unchanged');

  const callsAfterMiss = fetchCalls;
  const cached = await solar.getSolarForecast('solcast');
  assert.strictEqual(cached, first, 'cache hit should preserve the established cached response object');
  assert.strictEqual(cached.server_today, localDateString(), 'cache hit carries current server day');
  assert.strictEqual(fetchCalls, callsAfterMiss, 'cache hit does not make another upstream call');

  const restCfg = JSON.stringify([{ name: 'test', enabled: true, url: 'https://example.invalid' }]);
  cfg.external_sources = restCfg;
  const rest = await solar.getSolarForecast('rest:test');
  assert.strictEqual(rest.server_today, localDateString());
  assert.deepStrictEqual(rest.hourly, [], 'REST source remains without forecast energy periods');
  assert.strictEqual(rest.source, 'rest:test');

  console.log('metric-trend-forecast-contract: 1 test passed');
  checks.done();
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
