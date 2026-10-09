'use strict';
/**
 * Hourly energy for one local day: kWh per hour, the split of that energy into
 * flows (solar to home, solar to battery, ...), battery charge per hour, and
 * what each hour cost or earned.
 *
 * Power samples (W) come from the history table and its 5-minute rollups via
 * timeseriesReader. Each sample counts until the next one, capped so a data
 * gap is not filled in with a stale value.
 *
 * Flows follow the usual priority, applied to each sample:
 *   solar  -> home, then battery, then grid
 *   home   <- solar, then battery, then grid, then generator
 *   battery charge <- solar, then grid, then generator
 *   export <- solar, then battery
 *
 * @module energyHourly
 */

const { readHistorySeries } = require('./timeseriesReader');

const FIELDS = ['solar', 'consumption', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc', 'generator'];
const FLOWS = ['solar_to_home', 'solar_to_battery', 'solar_to_grid', 'battery_to_home', 'battery_to_grid', 'grid_to_home', 'grid_to_battery', 'generator_to_home', 'generator_to_battery'];
const MAX_SAMPLE_SECONDS = 600;   // a sample stands for at most 10 minutes
const ROLLUP_SECONDS = 300;

const watts = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Split one sample's power (W) into flows (W). */
function splitFlows(s) {
  const solar = watts(s.solar), load = watts(s.consumption), charge = watts(s.battery_charge);
  const discharge = watts(s.battery_discharge), imp = watts(s.grid_import), exp = watts(s.grid_export), gen = watts(s.generator);
  const out = {};
  out.solar_to_home = Math.min(solar, load);
  let solarLeft = solar - out.solar_to_home, loadLeft = load - out.solar_to_home;
  out.battery_to_home = Math.min(discharge, loadLeft); loadLeft -= out.battery_to_home;
  out.grid_to_home = Math.min(imp, loadLeft); loadLeft -= out.grid_to_home;
  out.generator_to_home = Math.min(gen, loadLeft);
  out.solar_to_battery = Math.min(solarLeft, charge); solarLeft -= out.solar_to_battery;
  out.grid_to_battery = Math.min(imp - out.grid_to_home, charge - out.solar_to_battery);
  out.generator_to_battery = Math.min(gen - out.generator_to_home, charge - out.solar_to_battery - Math.max(0, out.grid_to_battery));
  out.solar_to_grid = Math.min(solarLeft, exp);
  out.battery_to_grid = Math.min(discharge - out.battery_to_home, exp - out.solar_to_grid);
  for (const k of FLOWS) out[k] = Math.max(0, out[k]);
  return out;
}

/** Local start of each hour of `date` ('YYYY-MM-DD'), plus the next midnight. */
function hourStarts(date) {
  const [y, m, d] = date.split('-').map(Number);
  const starts = [];
  for (let h = 0; ; h++) {
    const t = new Date(y, m - 1, d, h, 0, 0, 0);
    if (t.getDate() !== d && h > 0) { starts.push(Math.floor(t.getTime() / 1000)); break; }
    const s = Math.floor(t.getTime() / 1000);
    if (!starts.length || s > starts[starts.length - 1]) starts.push(s);   // DST: skip a repeated hour start
    if (h > 26) break;
  }
  return starts; // n hours + 1 end
}

/**
 * @param db better-sqlite3 database
 * @param {{date: string, prices?: {buy?: number, sell?: number, batteryWear?: number, generator?: number}, now?: number}} opts
 */
function readHourlyEnergy(db, { date, prices = {}, now = Math.floor(Date.now() / 1000) }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date must be YYYY-MM-DD');
  const bounds = hourStarts(date), from = bounds[0], to = bounds[bounds.length - 1];
  const buy = Math.max(0, Number(prices.buy) || 0), sell = Math.max(0, Number(prices.sell) || 0), wear = Math.max(0, Number(prices.batteryWear) || 0);
  const genPrice = Math.max(0, Number(prices.generator) || 0);
  const hours = bounds.slice(0, -1).map((start, i) => ({
    start, end: bounds[i + 1], seconds: 0,
    energy: Object.fromEntries(FIELDS.filter(f => f !== 'battery_soc').map(f => [f, 0])),
    flows: Object.fromEntries(FLOWS.map(f => [f, 0])),
    soc: { min: null, max: null, last: null, sum: 0, n: 0 }
  }));
  const rows = from < now ? readHistorySeries(db, { from, to: Math.min(to, now), fields: FIELDS }) : [];
  const hourOf = t => { for (let i = 0; i < hours.length; i++) if (t >= hours[i].start && t < hours[i].end) return i; return -1; };

  rows.forEach((row, i) => {
    const next = rows[i + 1];
    const isRollup = row.solar_count > 1 || row.consumption_count > 1;
    const span = next ? next.timestamp - row.timestamp : Math.min(now, to) - row.timestamp;
    const seconds = Math.max(0, Math.min(span, isRollup ? ROLLUP_SECONDS : MAX_SAMPLE_SECONDS));
    if (!seconds) return;
    const flows = splitFlows(row);
    // Spread the sample over the hours it covers (usually just one).
    let t = row.timestamp, left = seconds;
    while (left > 0) {
      const h = hourOf(t); if (h < 0) break;
      const part = Math.min(left, hours[h].end - t), kwh = part / 3600 / 1000, hr = hours[h];
      hr.seconds += part;
      for (const f of Object.keys(hr.energy)) hr.energy[f] += watts(row[f]) * kwh;
      for (const f of FLOWS) hr.flows[f] += flows[f] * kwh;
      t += part; left -= part;
    }
    const soc = Number(row.battery_soc), h = hourOf(row.timestamp);
    if (h >= 0 && row.battery_soc != null && Number.isFinite(soc)) {
      const s = hours[h].soc;
      s.min = s.min == null ? soc : Math.min(s.min, soc); s.max = s.max == null ? soc : Math.max(s.max, soc);
      s.last = soc; s.sum += soc; s.n++;
    }
  });

  const totals = { energy: {}, flows: {}, costs: { grid_cost: 0, grid_earnings: 0, battery_cost: 0, generator_cost: 0, result: 0 } };
  const out = hours.map(hr => {
    const energy = Object.fromEntries(Object.entries(hr.energy).map(([k, v]) => [k, round(v)]));
    const flows = Object.fromEntries(Object.entries(hr.flows).map(([k, v]) => [k, round(v)]));
    const costs = {
      grid_cost: round(energy.grid_import * buy, 2),
      grid_earnings: round(energy.grid_export * sell, 2),
      battery_cost: round((energy.battery_charge + energy.battery_discharge) * wear, 2),
      generator_cost: round(energy.generator * genPrice, 2)
    };
    costs.result = round(costs.grid_earnings - costs.grid_cost - costs.battery_cost - costs.generator_cost, 2);
    for (const [k, v] of Object.entries(energy)) totals.energy[k] = (totals.energy[k] || 0) + v;
    for (const [k, v] of Object.entries(flows)) totals.flows[k] = (totals.flows[k] || 0) + v;
    for (const k of Object.keys(totals.costs)) totals.costs[k] += costs[k];
    const span = hr.end - hr.start;
    return {
      start: hr.start, end: hr.end,
      status: hr.start >= now ? 'future' : (hr.end > now ? 'current' : 'past'),
      coverage: round(Math.min(1, hr.seconds / span), 3),
      energy, flows, costs,
      soc: hr.soc.n ? { min: round(hr.soc.min, 1), max: round(hr.soc.max, 1), avg: round(hr.soc.sum / hr.soc.n, 1), last: round(hr.soc.last, 1) } : null
    };
  });
  for (const group of ['energy', 'flows']) for (const k of Object.keys(totals[group])) totals[group][k] = round(totals[group][k]);
  for (const k of Object.keys(totals.costs)) totals.costs[k] = round(totals.costs[k], 2);
  return { schemaVersion: 1, date, from, to, unit: 'kWh', prices: { buy, sell, batteryWear: wear, generator: genPrice }, hours: out, totals };
}

module.exports = { readHourlyEnergy, splitFlows, hourStarts, FLOWS };
