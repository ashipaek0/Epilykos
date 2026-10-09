'use strict';
const checks = require('./_checks');
// Hourly energy, flow split and costs (modules/energyHourly.js).
const assert = require('node:assert/strict');
const { readHourlyEnergy, splitFlows, hourStarts } = require('../modules/energyHourly');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

// A fake db: raw history rows only (recent enough to skip the rollup cutoff).
function fixture(rows) {
  return { prepare(sql) { return { all: (...a) => sql.includes('history_5m') ? [] : rows.filter(r => r.timestamp >= a[0] && r.timestamp < a[1]) }; } };
}
const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const at = (h, m = 0) => Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).getTime() / 1000);

check('flows: solar serves the home first, then the battery, then the grid', () => {
  const f = splitFlows({ solar: 5000, consumption: 2000, battery_charge: 2500, grid_export: 500 });
  assert.equal(f.solar_to_home, 2000); assert.equal(f.solar_to_battery, 2500); assert.equal(f.solar_to_grid, 500);
  assert.equal(f.battery_to_home + f.grid_to_home + f.grid_to_battery + f.battery_to_grid, 0);
});

check('flows: at night the home is served by the battery, then the grid', () => {
  const f = splitFlows({ solar: 0, consumption: 3000, battery_discharge: 2000, grid_import: 1500, battery_charge: 0 });
  assert.equal(f.battery_to_home, 2000); assert.equal(f.grid_to_home, 1000); assert.equal(f.grid_to_battery, 0);
});

check('flows: grid charging the battery and battery export are counted', () => {
  assert.equal(splitFlows({ consumption: 500, grid_import: 2500, battery_charge: 2000 }).grid_to_battery, 2000);
  assert.equal(splitFlows({ consumption: 500, battery_discharge: 1500, grid_export: 1000 }).battery_to_grid, 1000);
});

check('a normal day has 24 local hours', () => {
  const b = hourStarts('2026-06-15');
  assert.equal(b.length, 25); assert.ok(b.every((t, i) => i === 0 || t > b[i - 1]));
  assert.equal(new Date(b[0] * 1000).getHours(), 0);
});

check('constant 2 kW load for one hour is 2 kWh in that hour, with costs', () => {
  const rows = [];
  for (let t = at(1); t < at(2); t += 60) rows.push({ timestamp: t, consumption: 2000, grid_import: 1000, battery_discharge: 1000, battery_soc: 80 - (t - at(1)) / 360 });
  const out = readHourlyEnergy(fixture(rows), { date, prices: { buy: 200, sell: 50, batteryWear: 20 }, now: at(23) });
  const h = out.hours[1];
  assert.equal(out.hours.length, 24);
  assert.ok(Math.abs(h.energy.consumption - 2) < 0.02, `consumption ${h.energy.consumption}`);
  assert.ok(Math.abs(h.flows.battery_to_home - 1) < 0.02 && Math.abs(h.flows.grid_to_home - 1) < 0.02);
  assert.ok(Math.abs(h.costs.grid_cost - 200) < 3, `grid cost ${h.costs.grid_cost}`);
  assert.ok(Math.abs(h.costs.battery_cost - 20) < 1, `battery cost ${h.costs.battery_cost}`);
  assert.ok(Math.abs(h.costs.result + 220) < 4);
  assert.equal(h.soc.max, 80); assert.ok(h.soc.min < 71);
  assert.ok(h.coverage > 0.98);
  assert.equal(out.hours[0].energy.consumption, 0); assert.equal(out.hours[0].coverage, 0);
  assert.equal(out.prices.buy, 200);
});

check('a data gap is not filled in with the last value', () => {
  const out = readHourlyEnergy(fixture([{ timestamp: at(3), consumption: 1000 }, { timestamp: at(6), consumption: 1000 }]), { date, now: at(23) });
  assert.ok(out.hours[3].energy.consumption <= 1000 * 600 / 3600 / 1000 + 1e-3, 'one sample counts for at most 10 minutes');
  assert.equal(out.hours[4].energy.consumption, 0); assert.equal(out.hours[5].energy.consumption, 0);
});

check('a sample spanning an hour boundary is split between both hours', () => {
  const out = readHourlyEnergy(fixture([{ timestamp: at(7, 55), solar: 3600 }, { timestamp: at(8, 5), solar: 0 }]), { date, now: at(23) });
  assert.ok(Math.abs(out.hours[7].energy.solar - 0.3) < 1e-6); assert.ok(Math.abs(out.hours[8].energy.solar - 0.3) < 1e-6);
});

check('hours after now are marked future and hold no energy', () => {
  const out = readHourlyEnergy(fixture([{ timestamp: at(10), solar: 1000 }]), { date, now: at(10, 30) });
  assert.equal(out.hours[10].status, 'current'); assert.equal(out.hours[11].status, 'future'); assert.equal(out.hours[9].status, 'past');
  assert.equal(out.hours[11].energy.solar, 0);
});

check('bad dates are refused', () => { assert.throws(() => readHourlyEnergy(fixture([]), { date: 'yesterday' })); });

console.log(`energy-hourly: ${passed} checks passed`);
checks.done();
