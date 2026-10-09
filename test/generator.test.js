'use strict';
const checks = require('./_checks');
/**
 * Generator input (inverters with a separate generator port), with made-up values:
 * - an older database gains the generator columns in history and history_5m;
 * - the history poll records the generator / daily_generator roles;
 * - the 5-minute rollup carries generator power and today's generator energy;
 * - hourly energy has generator kWh, generator flows and a generator cost
 *   taken off the hour's result;
 * - solar savings by the three methods: grid price, grid availability (solar
 *   during an outage at the generator price) and what was bought that day.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-generator-'));
process.chdir(tmp);

// An older install: history and history_5m without the generator columns.
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
{
  const Database = require('better-sqlite3');
  const old = new Database(path.join(tmp, 'data', 'energy.db'));
  old.exec(`CREATE TABLE history (timestamp INTEGER PRIMARY KEY, consumption REAL, solar REAL, battery_charge REAL, battery_discharge REAL,
    grid_import REAL, grid_export REAL, battery_soc REAL, daily_consumption REAL, daily_solar REAL, daily_battery_charge REAL,
    daily_battery_discharge REAL, daily_grid_import REAL, daily_grid_export REAL)`);
  old.prepare('INSERT INTO history (timestamp, solar) VALUES (?, ?)').run(1000, 5);
  old.close();
}
const database = require(path.join(REPO, 'modules/database'));
database.initializeDatabase();
const db = database.getDb();
const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
assert.ok(cols('history').includes('generator') && cols('history').includes('daily_generator'), 'old history gains generator columns');
for (const c of ['generator_avg', 'generator_min', 'generator_max', 'generator_count', 'generator_last_value', 'generator_last_timestamp', 'daily_generator_last']) {
  assert.ok(cols('history_5m').includes(c), `history_5m has ${c}`);
}
assert.strictEqual(db.prepare('SELECT solar FROM history WHERE timestamp = 1000').get().solar, 5, 'old rows kept');

const { clearDailySnapshotCache } = require(path.join(REPO, 'modules/timeseriesReader'));

(async () => {
  // History poll: the generator roles are recorded from their mapped metrics.
  database.setConfig('role_metrics', JSON.stringify({ solar: 'pv_power', generator: 'gen_power', daily_generator: 'gen_today' }));
  const upsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)');
  const t0 = Math.floor(Date.now() / 1000);
  upsert.run('pv_power', 1200, t0, 'W'); upsert.run('gen_power', 3400, t0, 'W'); upsert.run('gen_today', 2.5, t0, 'kWh');
  await require(path.join(REPO, 'modules/history')).pollLegacyHistory();
  const row = db.prepare('SELECT solar, generator, daily_generator FROM history ORDER BY timestamp DESC LIMIT 1').get();
  assert.deepStrictEqual([row.solar, row.generator, row.daily_generator], [1200, 3400, 2.5], 'poll records generator power and energy');

  // Rollup: generator average, count and last daily value.
  const { runRollupOnce } = require(path.join(REPO, 'modules/retentionJob'));
  const now = 2_000_000_200, cutoff = now - 30 * 86400;
  const bucket = Math.floor((cutoff - 600) / 300) * 300;
  const ins = db.prepare('INSERT INTO history (timestamp, generator, daily_generator) VALUES (?, ?, ?)');
  ins.run(bucket + 10, 2000, 1.0); ins.run(bucket + 70, 4000, 1.2);
  await runRollupOnce({ now });
  const r = db.prepare('SELECT generator_avg, generator_min, generator_max, generator_count, daily_generator_last FROM history_5m WHERE bucket_start = ?').get(bucket);
  assert.deepStrictEqual([r.generator_avg, r.generator_min, r.generator_max, r.generator_count, r.daily_generator_last], [3000, 2000, 4000, 2, 1.2]);

  // Hourly energy: generator kWh, flows and cost.
  const { readHourlyEnergy, splitFlows } = require(path.join(REPO, 'modules/energyHourly'));
  const f = splitFlows({ solar: 500, consumption: 3000, battery_charge: 1000, battery_discharge: 0, grid_import: 0, grid_export: 0, generator: 3500 });
  assert.strictEqual(f.solar_to_home, 500);
  assert.strictEqual(f.generator_to_home, 2500, 'generator covers the rest of the home');
  assert.strictEqual(f.generator_to_battery, 1000, 'and charges the battery');
  const y = new Date(); y.setDate(y.getDate() - 1);
  const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const start = Math.floor(new Date(y.getFullYear(), y.getMonth(), y.getDate(), 10).getTime() / 1000);
  for (let t = start; t < start + 3600; t += 60) ins.run(t, 2000, null);   // 2 kW for an hour = 2 kWh
  const hourly = readHourlyEnergy(db, { date: day, prices: { buy: 0.3, generator: 0.5 }, now: start + 7200 });
  const h = hourly.hours.find(x => x.start === start);
  assert.ok(Math.abs(h.energy.generator - 2) < 0.05, `2 kWh from the generator (${h.energy.generator})`);
  assert.ok(Math.abs(h.costs.generator_cost - 1) < 0.03, `costs 1.00 (${h.costs.generator_cost})`);
  assert.ok(Math.abs(h.costs.result + h.costs.generator_cost + h.costs.grid_cost + h.costs.battery_cost - h.costs.grid_earnings) < 0.011, 'result takes off the generator cost');
  assert.strictEqual(hourly.prices.generator, 0.5);

  // Savings by method, on two made-up past days.
  db.exec('DELETE FROM history; DELETE FROM history_5m; DELETE FROM grid_status;');
  clearDailySnapshotCache(db);
  const { computeSavings, clearSolarValueCache } = require(path.join(REPO, 'modules/solarValue'));
  const day1 = new Date(); day1.setDate(day1.getDate() - 3); day1.setHours(0, 0, 0, 0);
  const d1 = Math.floor(day1.getTime() / 1000);
  const hist = db.prepare('INSERT INTO history (timestamp, solar, daily_solar, daily_grid_import, daily_generator) VALUES (?, ?, ?, ?, ?)');
  // 10:00-14:00 at 1 kW, readings every minute; the grid is down 12:00-14:00 (half the solar).
  for (let t = d1 + 10 * 3600; t < d1 + 14 * 3600; t += 60) hist.run(t, 1000, 4, 2, 3);
  hist.run(d1 + 23 * 3600, 0, 4, 2, 3);
  db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(d1 + 12 * 3600, 0);
  db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(d1 + 14 * 3600, 1);
  database.setConfig('savings_rate', '0.30');
  database.setConfig('generator_price', '0.50');
  const past = s => s.all - s.today;   // today has no data: all = the past day

  const run = method => { database.setConfig('savings_method', method); clearSolarValueCache(db); return computeSavings({ todaySolarKwh: 0, db }); };
  const grid = run('grid');
  assert.ok(Math.abs(past(grid) - 4 * 0.30) < 1e-6, `grid price: 4 kWh x 0.30 (${past(grid)})`);
  const avail = run('availability');
  assert.ok(Math.abs(past(avail) - (2 * 0.30 + 2 * 0.50)) < 0.02, `availability: half at grid, half at generator price (${past(avail)})`);
  const bought = run('bought');
  // Bought 2 kWh grid + 3 kWh generator: (2x0.30 + 3x0.50) / 5 = 0.42 per kWh.
  assert.ok(Math.abs(past(bought) - 4 * 0.42) < 1e-6, `bought: average bought price (${past(bought)})`);
  assert.strictEqual(bought.method, 'bought');

  // No grid status at all: availability falls back to the grid price.
  db.exec('DELETE FROM grid_status');
  const noStatus = run('availability');
  assert.ok(Math.abs(past(noStatus) - 4 * 0.30) < 1e-6, 'no grid status: grid price');
  // Unknown method: grid price.
  assert.strictEqual(run('nonsense').method, 'grid');

  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
