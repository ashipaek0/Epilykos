'use strict';
// Consumption, base load and solar forecasts per hour (modules/energyForecast.js).
const assert = require('node:assert/strict');

// solar.js needs modules/database; stub it like the other solar tests.
const dbId = require.resolve('../modules/database');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { getConfig: () => undefined, setConfig: () => {}, flushMetrics: () => 0, getDb: () => null } };
const { hourlyForecast, solarByHour, percentile, clearForecastCache } = require('../modules/energyForecast');
const { hourStarts } = require('../modules/energyHourly');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

const fixture = rows => ({ prepare(sql) { return { all: (...a) => sql.includes('history_5m') ? [] : rows.filter(r => r.timestamp >= a[0] && r.timestamp < a[1]) }; } });
const today = new Date();
const dateOf = back => { const t = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const at = (back, h, m = 0) => Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, h, m).getTime() / 1000);

// Past days: 500 W all day, except 18:00-19:00 which uses (1000 + 100*day) W.
function history(days) {
  const rows = [];
  for (let back = 1; back <= days; back++) for (let t = at(back, 0); t < at(back - 1, 0); t += 300) {
    const h = new Date(t * 1000).getHours();
    rows.push({ timestamp: t, consumption: h === 18 ? 1000 + 100 * back : 500 });
  }
  return rows;
}

check('percentile interpolates', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3); assert.equal(percentile([10, 20], 50), 15); assert.equal(percentile([], 50), null);
});

check('consumption forecast is the median of the same hour on earlier days, with a range', () => {
  clearForecastCache();
  const out = hourlyForecast(fixture(history(10)), { date: dateOf(0), now: at(0, 23) });
  assert.equal(out.historyDays, 10);
  const evening = out.hours[18].consumption, night = out.hours[3].consumption;
  assert.ok(Math.abs(night.expected - 0.5) < 0.01, `night ${night.expected}`);
  assert.ok(Math.abs(evening.expected - 1.55) < 0.02, `evening ${evening.expected}`);   // median of 1.1 .. 2.0
  assert.ok(evening.low < evening.expected && evening.high > evening.expected);
  assert.ok(Math.abs(out.baseLoad - 0.5) < 0.01 || Math.abs(out.hours[0].baseLoad - 0.5) < 0.01);
  assert.ok(Math.abs(out.day.consumption.expected - (23 * 0.5 + 1.55)) < 0.1);
});

check('fewer than 3 days of history gives no forecast', () => {
  clearForecastCache();
  const out = hourlyForecast(fixture(history(2)), { date: dateOf(0), now: at(0, 23) });
  assert.equal(out.hours[3].consumption, null); assert.equal(out.day.consumption, null); assert.equal(out.hours[3].baseLoad, null);
});

check('solar forecast periods are summed into kWh per hour, with the P10-P90 range', () => {
  const starts = hourStarts(dateOf(0));
  const end = (h, m) => new Date(at(0, h, m) * 1000).toISOString();
  const periods = [
    { period_end: end(12, 30), period: 'PT30M', pv_estimate: 4, pv_estimate10: 3, pv_estimate90: 5 },
    { period_end: end(13, 0), period: 'PT30M', pv_estimate: 2, pv_estimate10: 1, pv_estimate90: 3 }
  ];
  const hours = solarByHour(periods, starts);
  assert.deepEqual(hours[12], { expected: 3, low: 2, high: 4 });
  assert.equal(hours[11], null); assert.equal(hours[13], null);
});

console.log(`energy-forecast: ${passed} checks passed`);

const { projectBattery } = require('../modules/energyForecast');
check('battery projection adds forecast solar minus load each hour, within limits', () => {
  const hourStart = h => at(0, h), hourly = { hours: Array.from({ length: 24 }, (_, h) => ({ start: hourStart(h), end: hourStart(h) + 3600, soc: h <= 10 ? { last: 50 } : null })) };
  const forecast = { hours: Array.from({ length: 24 }, (_, h) => ({ consumption: { expected: 1 }, solar: { expected: h >= 11 && h < 16 ? 4 : 0 } })) };
  const p = projectBattery(hourly, forecast, { capacityKwh: 10, minSoc: 20, now: at(0, 11) });
  assert.equal(p.from, 50); assert.equal(p.hours[0].start, at(0, 11));
  assert.ok(Math.abs(p.hours[0].soc - 78.5) < 0.1, `11:00 ${p.hours[0].soc}`);   // +3 kWh x 0.95
  assert.equal(p.hours[0].state, 'charging'); assert.equal(p.hours[1].soc, 100); assert.equal(p.hours[1].state, 'full');
  assert.equal(p.hours[2].state, 'full'); assert.equal(p.hours[6].state, 'discharging');
  assert.equal(p.hours[p.hours.length - 1].soc, 20, 'never below the lowest charge');
  assert.equal(p.hours[p.hours.length - 1].state, 'empty');
  assert.equal(projectBattery(hourly, forecast, { capacityKwh: 0, now: at(0, 11) }), null, 'needs a capacity');
  const f0 = p.hours[0].flows;
  assert.equal(f0.solar_to_home, 1); assert.equal(f0.solar_to_battery, 3); assert.equal(f0.grid_to_home, 0);
  assert.ok(p.hours[1].spareSolar > 0, 'solar beyond a full battery is reported as spare');
  const last = p.hours[p.hours.length - 1].flows;
  assert.equal(last.solar_to_home, 0); assert.ok(last.grid_to_home > 0, 'once the battery is at its lowest charge the grid covers the home');
  assert.ok(Math.abs(last.battery_to_home + last.grid_to_home - 1) < 1e-6);
});
console.log(`energy-forecast (battery): ok`);
