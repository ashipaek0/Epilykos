#!/usr/bin/env node
/**
 * test/solar-forecast-today.test.js — today's forecast keeps its earlier
 * periods, and periods without weather get it from Open-Meteo.
 *
 * Solcast returns periods from "now" onwards only, so without this the PV
 * Today and Solar Forecast cards lost the morning of the predicted curve as
 * the day went on, and Solcast rooftop periods (no weather code, often no
 * cloud cover) left the PV Today weather row empty.
 *
 * Plain node, no network, no real DB: modules/database.js is stubbed in the
 * require cache before modules/solar.js loads (as in the other solar tests).
 */
'use strict';

const assert = require('assert');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

const cfg = {};
const dbId = require.resolve('../modules/database');
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: {
    getConfig: (k) => cfg[k],
    setConfig: (k, v) => { cfg[k] = String(v); },
    flushMetrics: () => 0,
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) })
  }
};

const solar = require('../modules/solar');

// Half-hour periods (Solcast style) for today, stamped at their end.
function at(h, m = 0) { const d = new Date(); d.setHours(h, m, 0, 0); return d; }
function periods(fromHour, toHour) {
  const out = [];
  for (let t = at(fromHour).getTime(); t <= at(toHour).getTime(); t += 1800000) {
    out.push({ period_end: new Date(t).toISOString(), period: 'PT30M', pv_estimate: 1, pv_estimate10: 0.5, pv_estimate90: 1.5 });
  }
  return out;
}

check('first fetch of the day passes through unchanged', () => {
  const morning = periods(7, 20);
  const out = solar.withTodaysEarlierPeriods('solcast', morning);
  assert.strictEqual(out.length, morning.length);
  assert.ok(cfg.forecast_today_periods, 'remembered periods are saved');
});

check('a later fetch gets the earlier periods back, in order, before the fresh ones', () => {
  const midday = periods(12, 20);
  const out = solar.withTodaysEarlierPeriods('solcast', midday);
  const ends = out.map(p => new Date(p.period_end).getTime());
  assert.strictEqual(new Date(out[0].period_end).getHours(), 7, 'starts at the first period seen today');
  assert.ok(ends.every((t, i) => i === 0 || t > ends[i - 1]), 'sorted, no duplicates');
  const earlier = out.filter(p => p.earlier);
  assert.strictEqual(earlier.length, periods(7, 12).length - 1, 'every period from 07:00 to 11:30 is restored');
  assert.ok(earlier.every(p => p.pv_estimate === 1 && p.pv_estimate90 === 1.5), 'the earlier forecast values are kept');
});

check('sources are remembered separately', () => {
  const om = periods(12, 13);
  const out = solar.withTodaysEarlierPeriods('open-meteo', om);
  assert.strictEqual(out.length, om.length, 'Solcast periods never leak into Open-Meteo');
});

check('survives a restart: remembered periods are read back from config', () => {
  delete require.cache[require.resolve('../modules/solar')];
  const fresh = require('../modules/solar');
  const out = fresh.withTodaysEarlierPeriods('solcast', periods(15, 20));
  assert.strictEqual(new Date(out[0].period_end).getHours(), 7);
});

check('weather is filled from Open-Meteo hourly where a period lacks it', () => {
  const ps = periods(9, 10);
  ps[0].cloud_cover = 12; // keep a value the source did provide
  const omHourly = [];
  for (let h = 0; h < 24; h++) omHourly.push({ ms: at(h).getTime(), code: h < 10 ? 1 : 61, cloud_cover: h * 4, is_day: 1 });
  solar.fillPeriodWeather(ps, omHourly);
  assert.ok(ps.every(p => p.weather_code != null && p.cloud_cover != null && p.is_day != null), 'every period has weather');
  assert.strictEqual(ps[0].cloud_cover, 12, "the source's own cloud cover is not overwritten");
  // Open-Meteo's value at 10:00 describes 09:00-10:00 (code 1 before 10:00, 61 from 10:00 here).
  const end = (h, m) => ps.find(p => new Date(p.period_end).getHours() === h && new Date(p.period_end).getMinutes() === m);
  assert.strictEqual(end(9, 0).weather_code, 1, '08:30-09:00 takes the hour ending 09:00');
  assert.strictEqual(end(10, 0).weather_code, 61, '09:30-10:00 takes the hour ending 10:00');
});

console.log(`solar-forecast-today: ${passed} checks passed`);
