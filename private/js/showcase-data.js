/**
 * Showcase data: a made-up home with 5 kW of solar on two roofs, a 10 kWh
 * battery and a grid that drops out now and then, simulated in the browser in
 * 5-minute steps. Every API answer the showcase cards ask for is built from
 * this one simulation, in the same shape the server sends, so the cards agree
 * with each other. Nothing here reads from or writes to the server.
 *
 * @module showcase-data
 */

const STEP_MS = 5 * 60 * 1000;
const DT_H = STEP_MS / 3600000;
const SIM_DAYS = 35;
const CAPACITY_W = 5000;
const BATTERY_WH = 15000;
const BATTERY_MAX_W = 3000;
const MIN_SOC = 20;
export const PRICES = { buy: 0.3, sell: 0.08, batteryWear: 0.04, generator: 0.45 };
export const CURRENCY = '€';

/** Repeatable 0..1 noise for a number. */
function noise(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const pad = n => String(n).padStart(2, '0');
/** Local YYYY-MM-DD. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function hourOf(ms) { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }
/** Day number used to seed each day's weather and outages. */
function dayNumber(ms) { const d = new Date(ms); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); }
const round = (v, p = 4) => { const f = 10 ** p; return Math.round(v * f) / f; };

/** How clear a day is, 0.35 (overcast) to 1 (clear). */
function clearness(ms) { return 0.35 + 0.65 * noise(dayNumber(ms)); }
/** The weather code that goes with a day's clearness. */
function weatherCode(clear) { return clear > 0.85 ? 0 : clear > 0.65 ? 2 : clear > 0.48 ? 3 : 61; }

/** Solar power (W) for a clear-sky share of the day, without clouds. */
function clearSkySolar(h) {
  if (h <= 6.25 || h >= 18.35) return 0;
  return CAPACITY_W * 0.9 * Math.pow(Math.sin(Math.PI * (h - 6.25) / 12.1), 1.2);
}
function solarAt(ms) {
  const ripple = 0.86 + 0.14 * noise(Math.floor(ms / 1800000));
  return clearSkySolar(hourOf(ms)) * clearness(ms) * ripple;
}
/** Share of the solar that comes from the east roof (more in the morning). */
function eastShare(ms) { const h = hourOf(ms); return h < 12 ? 0.68 : h < 14 ? 0.5 : 0.34; }
function loadAt(ms) {
  const h = hourOf(ms);
  let w = 380 + 260 * noise(Math.floor(ms / STEP_MS));
  if (h >= 6.5 && h < 8.5) w += 650;
  if (h >= 12 && h < 13) w += 420;
  if (h >= 18.5 && h < 22) w += 950;
  return w;
}
/** Grid outages: a night outage most days and an evening one some days. */
function gridOnAt(ms) {
  const h = hourOf(ms), n = dayNumber(ms);
  const nightStart = 1 + 2 * noise(n + 3), nightLen = 1 + 2.5 * noise(n + 5);
  if (noise(n + 11) > 0.2 && h >= nightStart && h < nightStart + nightLen) return false;
  if (noise(n + 7) > 0.55 && h >= 19 && h < 19 + 1.25 * noise(n + 9) + 0.25) return false;
  return true;
}

/** One 5-minute step from a state of charge. Returns the sample and the new SoC. */
function step(ms, soc) {
  const grid = gridOnAt(ms);
  let solar = solarAt(ms), load = loadAt(ms);
  let bc = 0, bd = 0, gi = 0, ge = 0, gen = 0;
  const roomW = (100 - soc) / 100 * BATTERY_WH / DT_H;
  const availW = Math.max(0, soc - MIN_SOC) / 100 * BATTERY_WH / DT_H;
  if (solar >= load) {
    bc = Math.min(solar - load, BATTERY_MAX_W, roomW);
    if (grid) ge = solar - load - bc;
    else solar = load + bc;                         // off grid: the inverter holds solar back
  } else {
    bd = Math.min(load - solar, BATTERY_MAX_W, availW);
    if (grid) gi = load - solar - bd;
    else gen = load - solar - bd;                   // off grid and the battery is low: the generator runs
  }
  const next = Math.max(0, Math.min(100, soc + (bc - bd) * DT_H / BATTERY_WH * 100));
  return { sample: { t: ms, solar, load, bc, bd, gi, ge, gen, soc: next, grid }, soc: next };
}

let samples = [];
let lastSoc = 55;

/** Extend the simulation up to now (it starts SIM_DAYS days ago at midnight). */
function simulate(now = Date.now()) {
  if (!samples.length) {
    let t = startOfDay(now) - SIM_DAYS * 86400000;
    let soc = 55;
    for (; t <= now; t += STEP_MS) { const r = step(t, soc); samples.push(r.sample); soc = r.soc; }
    lastSoc = soc;
    return samples;
  }
  let t = samples[samples.length - 1].t + STEP_MS;
  for (; t <= now; t += STEP_MS) { const r = step(t, lastSoc); samples.push(r.sample); lastSoc = r.soc; }
  return samples;
}

function between(from, to) { return simulate().filter(s => s.t >= from && s.t < to); }
const kwh = (list, key) => list.reduce((a, s) => a + s[key] * DT_H / 1000, 0);

function dayTotals(dayStart) {
  const list = between(dayStart, dayStart + 86400000);
  const solar = kwh(list, 'solar');
  const east = list.reduce((a, s) => a + s.solar * eastShare(s.t) * DT_H / 1000, 0);
  return {
    solar_kwh: solar, consumption_kwh: kwh(list, 'load'), battery_charge_kwh: kwh(list, 'bc'),
    battery_discharge_kwh: kwh(list, 'bd'), grid_import_kwh: kwh(list, 'gi'), grid_export_kwh: kwh(list, 'ge'),
    generator_kwh: kwh(list, 'gen'), east_kwh: east, west_kwh: solar - east, list
  };
}

// ── Live values ───────────────────────────────────────────────────────────

/** The values right now, with a small wobble so the cards move. */
function liveNow(now = Date.now()) {
  simulate(now);
  const last = samples[samples.length - 1];
  const wob = 1 + 0.04 * Math.sin(now / 6000) + 0.02 * Math.sin(now / 1700);
  const s = { ...last, solar: last.solar * wob, load: last.load * (2 - wob) };
  const surplus = s.solar - s.load;
  if (surplus >= 0) { s.bc = Math.min(surplus, s.bc > 0 || s.soc < 100 ? BATTERY_MAX_W : 0); s.bd = 0; s.ge = s.grid ? Math.max(0, surplus - s.bc) : 0; s.gi = 0; }
  else { s.bd = Math.min(-surplus, s.soc > MIN_SOC ? BATTERY_MAX_W : 0); s.bc = 0; s.gi = s.grid ? Math.max(0, -surplus - s.bd) : 0; s.ge = 0; }
  s.gen = !s.grid && surplus < 0 ? Math.max(0, -surplus - s.bd) : 0;
  return s;
}

/** Extra made-up readings that follow the simulated ones. */
function extras(s) {
  return {
    inverter_temperature: 33 + s.solar / 420 + (s.bd + s.bc) / 900,
    grid_voltage: s.grid ? 228 + 4 * Math.sin(s.t / 900000) : 0,
    battery_voltage: 50.4 + s.soc / 28,
    pv_voltage: s.solar > 20 ? 290 + s.solar / 55 : 0,
    load_percent: s.load / 50
  };
}

/** Control states the showcase's own switch and selector change (in this page only). */
export const controls = { 'switch.generator': 'off', 'select.inverter_mode': 'Solar first' };

function metricsFor(s, now, today) {
  const ex = extras(s);
  const m = (value, unit, type = 'number') => ({ value, type, timestamp: now, unit });
  return {
    solar: m(s.solar, 'W'), solar_east: m(s.solar * eastShare(now), 'W'), solar_west: m(s.solar * (1 - eastShare(now)), 'W'),
    consumption: m(s.load, 'W'), battery_charge: m(s.bc, 'W'), battery_discharge: m(s.bd, 'W'),
    grid_import: m(s.gi, 'W'), grid_export: m(s.ge, 'W'), battery_soc: m(s.soc, '%'), battery_power: m(s.bc - s.bd, 'W'),
    generator_power: m(s.gen || 0, 'W'), generator_energy_today: m(today.generator_kwh || 0, 'kWh'),
    daily_solar: m(today.solar_kwh, 'kWh'), daily_consumption: m(today.consumption_kwh, 'kWh'),
    daily_battery_charge: m(today.battery_charge_kwh, 'kWh'), daily_battery_discharge: m(today.battery_discharge_kwh, 'kWh'),
    daily_grid_import: m(today.grid_import_kwh, 'kWh'), daily_grid_export: m(today.grid_export_kwh, 'kWh'),
    grid_status: m(s.grid ? 1 : 0, null),
    inverter_temperature: m(ex.inverter_temperature, '°C'), grid_voltage: m(ex.grid_voltage, 'V'),
    battery_voltage: m(ex.battery_voltage, 'V'), pv_voltage: m(ex.pv_voltage, 'V'), load_percent: m(ex.load_percent, '%'),
    inverter_mode: m(s.grid ? (s.solar > s.load ? 'Solar + battery' : 'Grid + battery') : 'Off grid, battery', null, 'text'),
    'switch.generator': m(controls['switch.generator'], null, 'text'),
    'select.inverter_mode': m(controls['select.inverter_mode'], null, 'text')
  };
}

// ── Grid status ───────────────────────────────────────────────────────────

function segmentsFor(from, to) {
  const segs = [];
  for (const s of between(from, to)) {
    const state = s.grid ? 1 : 0, last = segs[segs.length - 1];
    if (last && last.state === state) last.end = Math.min(to, s.t + STEP_MS);
    else segs.push({ start: Math.max(from, s.t), end: Math.min(to, s.t + STEP_MS), state });
  }
  return segs;
}
const onHours = (from, to) => between(from, to).filter(s => s.grid).length * DT_H;

function gridState(now) {
  const all = simulate(now);
  const cur = all[all.length - 1];
  let i = all.length - 1;
  while (i > 0 && all[i - 1].grid === cur.grid) i--;
  const changed = all[i].t;
  let lastOn = null, lastOff = null;
  for (let k = all.length - 1; k > 0 && (lastOn === null || lastOff === null); k--) {
    if (all[k].grid && !all[k - 1].grid && lastOn === null) lastOn = all[k].t;
    if (!all[k].grid && all[k - 1].grid && lastOff === null) lastOff = all[k].t;
  }
  const d = new Date(now);
  const dayStart = startOfDay(now);
  const weekStart = dayStart - ((d.getDay() + 6) % 7) * 86400000;
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const daysBefore = Math.floor((monthStart - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000);
  const month = onHours(monthStart, now + 1);
  return {
    gridStatus: { configured: true, available: true, current: cur.grid, lastOn, lastOff, lastChange: { time: changed, state: cur.grid ? 1 : 0 } },
    gridHours: { day: onHours(dayStart, now + 1), week: onHours(weekStart, now + 1), month, year: month + daysBefore * 20.6, configured: true, available: true },
    gridTimeline: { configured: true, available: true, segments: segmentsFor(now - 86400000, now), windowStart: now - 86400000, windowEnd: now }
  };
}

// ── Dashboard state ───────────────────────────────────────────────────────

function savingsFor(totals) { return (totals.consumption_kwh - totals.grid_import_kwh) * PRICES.buy; }

export function dashboardState(now = Date.now()) {
  const s = liveNow(now);
  const dayStart = startOfDay(now);
  const today = dayTotals(dayStart);
  const d = new Date(now);
  const weekStart = dayStart - ((d.getDay() + 6) % 7) * 86400000;
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const span = (from) => { let sum = 0; for (let t = startOfDay(from); t <= dayStart; t += 86400000) sum += savingsFor(dayTotals(t)); return sum; };
  const month = span(monthStart);
  const savings = { currency: CURRENCY, rate: PRICES.buy, today: savingsFor(today), week: span(weekStart), month, all: month + 412.6 };
  const power = [];
  for (const p of between(now - 86400000, now + 1)) if (p.t % (10 * 60000) === 0) power.push(powerPoint(p));
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const t = dayStart - i * 86400000, x = dayTotals(t);
    daily.push({ day: dayKey(t), solar_kwh: x.solar_kwh, consumption_kwh: x.consumption_kwh, battery_charge_kwh: x.battery_charge_kwh,
      battery_discharge_kwh: x.battery_discharge_kwh, grid_import_kwh: x.grid_import_kwh, grid_export_kwh: x.grid_export_kwh, generator_kwh: x.generator_kwh });
  }
  return {
    current: {
      consumption_kw: s.load / 1000, solar_kw: s.solar / 1000, battery_charge_kw: s.bc / 1000, battery_discharge_kw: s.bd / 1000,
      battery_power_kw: (s.bc - s.bd) / 1000, grid_import_kw: s.gi / 1000, grid_export_kw: s.ge / 1000, battery_soc: s.soc,
      daily_consumption_kwh: today.consumption_kwh, daily_solar_kwh: today.solar_kwh, daily_battery_charge_kwh: today.battery_charge_kwh,
      daily_battery_discharge_kwh: today.battery_discharge_kwh, daily_grid_import_kwh: today.grid_import_kwh, daily_grid_export_kwh: today.grid_export_kwh,
      savings_currency: CURRENCY, savings_rate: PRICES.buy, today_savings: savings.today, all_time_savings: savings.all, timestamp: now
    },
    metrics: metricsFor(s, now, today),
    savings,
    ...gridState(now),
    powerHistory: power,
    dailyEnergyBar: daily,
    breakdowns: {
      metrics: {
        solar: { fn: 'sum', unit: 'W', parts: [{ metric: 'solar_east', label: 'East roof' }, { metric: 'solar_west', label: 'West roof' }] },
        daily_solar: { fn: 'energy_today', unit: 'kWh', parts: [
          { metric: 'solar_east', label: 'East roof', value: round(today.east_kwh, 2) },
          { metric: 'solar_west', label: 'West roof', value: round(today.west_kwh, 2) }] }
      },
      roles: {}
    }
  };
}

function powerPoint(p) {
  return { timestamp: p.t, consumption_kw: p.load / 1000, solar_kw: p.solar / 1000, battery_charge_kw: p.bc / 1000, battery_discharge_kw: p.bd / 1000,
    battery_power_kw: (p.bc - p.bd) / 1000, grid_import_kw: p.gi / 1000, grid_export_kw: p.ge / 1000, generator_kw: (p.gen || 0) / 1000, battery_soc: p.soc };
}

// ── History endpoints ─────────────────────────────────────────────────────

const METRIC_OF = {
  solar: p => p.solar, solar_east: p => p.solar * eastShare(p.t), solar_west: p => p.solar * (1 - eastShare(p.t)),
  consumption: p => p.load, battery_charge: p => p.bc, battery_discharge: p => p.bd, grid_import: p => p.gi, grid_export: p => p.ge,
  battery_soc: p => p.soc, battery_power: p => p.bc - p.bd, grid_status: p => (p.grid ? 1 : 0),
  inverter_temperature: p => extras(p).inverter_temperature, grid_voltage: p => extras(p).grid_voltage,
  battery_voltage: p => extras(p).battery_voltage, pv_voltage: p => extras(p).pv_voltage, load_percent: p => extras(p).load_percent
};

/** /api/metrics/history: [{ timestamp (ms), value }] every 10 minutes. */
export function metricHistory(metric, hours, now = Date.now()) {
  const get = METRIC_OF[metric];
  if (!get) return [];
  return between(now - hours * 3600000, now + 1).filter(p => p.t % 600000 === 0).map(p => ({ timestamp: p.t, value: get(p) }));
}

/** /api/history?days=N: raw power rows (W) with the day's running totals. */
export function powerRows(days, now = Date.now()) {
  const out = [];
  let day = null, acc = null;
  for (const p of between(startOfDay(now) - (days - 1) * 86400000, now + 1)) {
    const k = dayKey(p.t);
    if (k !== day) { day = k; acc = { c: 0, s: 0, bc: 0, bd: 0, gi: 0, ge: 0 }; }
    const f = DT_H / 1000;
    acc.c += p.load * f; acc.s += p.solar * f; acc.bc += p.bc * f; acc.bd += p.bd * f; acc.gi += p.gi * f; acc.ge += p.ge * f;
    if (p.t < now - days * 86400000) continue;
    out.push({ timestamp: p.t, consumption: p.load, solar: p.solar, battery_charge: p.bc, battery_discharge: p.bd, grid_import: p.gi, grid_export: p.ge,
      battery_soc: p.soc, daily_consumption: acc.c, daily_solar: acc.s, daily_battery_charge: acc.bc, daily_battery_discharge: acc.bd,
      daily_grid_import: acc.gi, daily_grid_export: acc.ge });
  }
  return out;
}

/** /api/history/power-stats for a window (seconds). */
export function powerStats(fromS, toS, fields) {
  const list = between(fromS * 1000, toS * 1000);
  const out = {};
  for (const f of fields) {
    const get = METRIC_OF[f === 'consumption' ? 'consumption' : f];
    if (!get || !list.length) {
      out[f] = { status: 'no_data', unit: 'W', sum: null, count: 0, mean: null, min: null, max: null, last: null,
        fidelity: { mean: 'unavailable', min: 'unavailable', max: 'unavailable', last: 'unavailable', warnings: [{ code: 'no_valid_observations', stats: ['mean', 'min', 'max', 'last'] }] } };
      continue;
    }
    const vals = list.map(get), sum = vals.reduce((a, v) => a + v, 0), last = list[list.length - 1];
    out[f] = { status: 'ok', unit: 'W', sum, count: vals.length, mean: sum / vals.length, min: Math.min(...vals), max: Math.max(...vals),
      last: { timestamp: Math.floor(last.t / 1000), value: get(last) },
      fidelity: { mean: 'stored_observations', min: 'stored_observations', max: 'stored_observations', last: 'stored_observations', warnings: [] } };
  }
  return { schemaVersion: 1, range: { from: fromS, to: toS, boundary: '[from,to)' }, fields: out };
}

/** /api/solar/intraday: today's solar every 5 minutes. */
export function solarIntraday(now = Date.now()) {
  let total = 0;
  return between(startOfDay(now), now + 1).map(p => { total += p.solar * DT_H / 1000; return { timestamp: Math.floor(p.t / 1000), watts: Math.round(p.solar), daily_solar: round(total) }; });
}

const solarParts = x => ({ solar_kwh: [{ label: 'East roof', value: round(x.east_kwh, 1) }, { label: 'West roof', value: round(x.west_kwh, 1) }] });

/** /api/daily?days=N: oldest first, today last. */
export function dailyRows(days, now = Date.now()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = startOfDay(now) - i * 86400000, x = dayTotals(t);
    out.push({ day: dayKey(t), consumption_kwh: x.consumption_kwh, solar_kwh: x.solar_kwh, battery_charge_kwh: x.battery_charge_kwh,
      battery_discharge_kwh: x.battery_discharge_kwh, grid_import_kwh: x.grid_import_kwh, grid_export_kwh: x.grid_export_kwh, generator_kwh: x.generator_kwh, parts: solarParts(x) });
  }
  return out;
}

/** /api/monthly: the last 12 months, oldest first. This month is simulated; earlier ones are scaled by season. */
export function monthlyRows(now = Date.now()) {
  const d = new Date(now);
  const thisMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const sim = { consumption_kwh: 0, solar_kwh: 0, battery_charge_kwh: 0, battery_discharge_kwh: 0, grid_import_kwh: 0, grid_export_kwh: 0, generator_kwh: 0, east_kwh: 0, west_kwh: 0 };
  let n = 0;
  for (let t = startOfDay(now) - 27 * 86400000; t <= startOfDay(now); t += 86400000) { const x = dayTotals(t); for (const k of Object.keys(sim)) sim[k] += x[k]; n++; }
  const avg = Object.fromEntries(Object.entries(sim).map(([k, v]) => [k, v / n]));
  const out = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const label = m.toLocaleDateString('en-US', { month: 'short' }) + ' ' + String(m.getFullYear()).slice(2);
    const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    let row;
    if (m.getTime() === thisMonth) {
      row = { consumption_kwh: 0, solar_kwh: 0, battery_charge_kwh: 0, battery_discharge_kwh: 0, grid_import_kwh: 0, grid_export_kwh: 0, generator_kwh: 0, east_kwh: 0, west_kwh: 0 };
      for (let t = thisMonth; t <= startOfDay(now); t += 86400000) { const x = dayTotals(t); for (const k of Object.keys(row)) row[k] += x[k]; }
    } else {
      const season = 1 + 0.18 * Math.cos((m.getMonth() - 2) / 12 * 2 * Math.PI);
      const sun = season * (0.92 + 0.16 * noise(m.getMonth() + 1));
      row = Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, v * days * (/solar|export|east|west|charge/.test(k) ? sun : 1)]));
      row.grid_import_kwh = Math.max(0, row.consumption_kwh - (row.solar_kwh - row.grid_export_kwh - row.battery_charge_kwh) - row.battery_discharge_kwh);
    }
    out.push({ month: key, display: label, consumption_kwh: row.consumption_kwh, solar_kwh: row.solar_kwh, battery_charge_kwh: row.battery_charge_kwh,
      battery_discharge_kwh: row.battery_discharge_kwh, grid_import_kwh: row.grid_import_kwh, grid_export_kwh: row.grid_export_kwh, generator_kwh: row.generator_kwh, parts: solarParts(row) });
  }
  return out;
}

// ── Hourly energy (Energy day, flows, costs, day totals) ─────────────────

function hourRow(start, now) {
  const end = start + 3600000;
  const list = between(start, Math.min(end, now + 1));
  const e = { solar: kwh(list, 'solar'), consumption: kwh(list, 'load'), battery_charge: kwh(list, 'bc'), battery_discharge: kwh(list, 'bd'), grid_import: kwh(list, 'gi'), grid_export: kwh(list, 'ge'), generator: kwh(list, 'gen') };
  const flows = { solar_to_home: 0, solar_to_battery: 0, solar_to_grid: 0, battery_to_home: 0, battery_to_grid: 0, grid_to_home: 0, grid_to_battery: 0, generator_to_home: 0, generator_to_battery: 0 };
  for (const p of list) {
    const f = DT_H / 1000;
    flows.solar_to_home += Math.min(p.solar, p.load) * f; flows.solar_to_battery += p.bc * f; flows.solar_to_grid += p.ge * f;
    flows.battery_to_home += p.bd * f; flows.grid_to_home += p.gi * f; flows.generator_to_home += p.gen * f;
  }
  const costs = { grid_cost: e.grid_import * PRICES.buy, grid_earnings: e.grid_export * PRICES.sell, battery_cost: e.battery_discharge * PRICES.batteryWear, generator_cost: e.generator * PRICES.generator };
  costs.result = costs.grid_earnings - costs.grid_cost - costs.battery_cost - costs.generator_cost;
  const socs = list.map(p => p.soc);
  const r4 = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));
  return {
    start: start / 1000, end: end / 1000,
    status: start >= now ? 'future' : (end > now ? 'current' : 'past'),
    coverage: round(list.length / 12, 3),
    energy: r4(e), flows: r4(flows), costs: r4(costs),
    soc: socs.length ? { min: round(Math.min(...socs), 1), max: round(Math.max(...socs), 1), avg: round(socs.reduce((a, v) => a + v, 0) / socs.length, 1), last: round(socs[socs.length - 1], 1) } : null
  };
}

/** Expected solar (kWh) for an hour from the forecast model (the "forecast" knows the day's clouds, roughly). */
function forecastSolarKwh(start) {
  let sum = 0;
  for (let t = start; t < start + 3600000; t += STEP_MS) sum += clearSkySolar(hourOf(t)) * clearness(t) * 0.94 * DT_H / 1000;
  return sum;
}
function forecastLoadKwh(start) {
  let sum = 0;
  for (let t = start; t < start + 3600000; t += STEP_MS) sum += (510 + (hourOf(t) >= 6.5 && hourOf(t) < 8.5 ? 650 : 0) + (hourOf(t) >= 12 && hourOf(t) < 13 ? 420 : 0) + (hourOf(t) >= 18.5 && hourOf(t) < 22 ? 950 : 0)) * DT_H / 1000;
  return sum;
}

/** /api/energy/hourly?date=YYYY-MM-DD[&forecast=1] */
export function energyHourly(date, withForecast, now = Date.now()) {
  const dayStart = new Date(date + 'T00:00:00').getTime();
  const hours = [];
  for (let i = 0; i < 24; i++) hours.push(hourRow(dayStart + i * 3600000, now));
  const sum = key => Object.fromEntries(Object.keys(hours[0][key]).map(k => [k, round(hours.reduce((a, h) => a + h[key][k], 0))]));
  const out = { schemaVersion: 1, date, from: dayStart / 1000, to: dayStart / 1000 + 86400, unit: 'kWh', prices: { ...PRICES },
    hours, totals: { energy: sum('energy'), flows: sum('flows'), costs: sum('costs') }, currency: CURRENCY };
  if (!withForecast) return out;
  const isToday = date === dayKey(now), future = dayStart >= startOfDay(now);
  const fh = hours.map(h => {
    const c = forecastLoadKwh(h.start * 1000);
    const sol = future ? round(forecastSolarKwh(h.start * 1000), 3) : null;
    return { start: h.start, consumption: { expected: round(c, 3), low: round(c * 0.93, 3), high: round(c * 1.08, 3), samples: 14 }, baseLoad: 0.51,
      solar: sol === null ? null : { expected: sol, low: round(sol * 0.8, 3), high: round(sol * 1.1, 3) } };
  });
  const dayC = fh.reduce((a, h) => a + h.consumption.expected, 0);
  const dayS = future ? fh.reduce((a, h) => a + h.solar.expected, 0) : null;
  out.forecast = { historyDays: 14, source: future ? 'open-meteo' : null, hours: fh,
    day: { consumption: { expected: round(dayC, 2), low: round(dayC * 0.95, 2), high: round(dayC * 1.05, 2) },
      solar: dayS === null ? null : { expected: round(dayS, 2), low: round(dayS * 0.8, 2), high: round(dayS * 1.1, 2) } } };
  if (isToday) out.forecast.battery = projectBattery(fh, now);
  return out;
}

function projectBattery(fh, now) {
  let soc = liveNow(now).soc;
  const from = soc, hours = [];
  for (const h of fh) {
    if (h.start * 1000 + 3600000 <= now) continue;
    const sun = h.solar ? h.solar.expected : 0, use = h.consumption.expected;
    const toHome = Math.min(sun, use);
    const room = (100 - soc) / 100 * BATTERY_WH / 1000;
    const toBat = Math.min(sun - toHome, room, BATTERY_MAX_W / 1000);
    const avail = Math.max(0, soc - MIN_SOC) / 100 * BATTERY_WH / 1000;
    const fromBat = Math.min(use - toHome, avail, BATTERY_MAX_W / 1000);
    soc = Math.max(0, Math.min(100, soc + (toBat - fromBat) / (BATTERY_WH / 1000) * 100));
    hours.push({ start: h.start, end: h.start + 3600, soc: round(soc, 1),
      state: soc >= 99.9 ? 'full' : toBat > fromBat ? 'charging' : fromBat > 0 ? 'discharging' : soc <= MIN_SOC + 0.1 ? 'empty' : 'idle',
      flows: { solar_to_home: round(toHome, 3), solar_to_battery: round(toBat, 3), battery_to_home: round(fromBat, 3), grid_to_home: round(use - toHome - fromBat, 3) },
      spareSolar: round(Math.max(0, sun - toHome - toBat), 3) });
  }
  return { from: round(from, 1), capacityKwh: BATTERY_WH / 1000, minSoc: MIN_SOC, hours };
}

// ── Solar forecast and weather ────────────────────────────────────────────

const WMO = { 0: ['Clear Sky', 'fi-sr-sun', 'fi-sr-moon'], 2: ['Partly Cloudy', 'fi-sr-cloud-sun', 'fi-sr-cloud-moon'],
  3: ['Overcast', 'fi-sr-clouds', 'fi-sr-clouds'], 61: ['Light Rain', 'fi-sr-cloud-rain', 'fi-sr-cloud-rain'] };
function wx(code, isDay = true) { const w = WMO[code]; return { code, desc: w[0], icon_class: 'fi ' + (isDay ? w[1] : w[2]) }; }
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const tempAt = ms => 23 + 7 * Math.max(0, Math.sin(Math.PI * (hourOf(ms) - 7) / 13)) - (1 - clearness(ms)) * 3;

function weatherDay(dayStart) {
  const clear = clearness(dayStart + 12 * 3600000), code = weatherCode(clear), w = wx(code);
  const tmax = round(30 - (1 - clear) * 3, 1), rain = code === 61 ? 70 : code === 3 ? 30 : 10;
  return { date: dayKey(dayStart), day_name: new Date(dayStart + 12 * 3600000).toLocaleDateString('en-US', { weekday: 'long' }),
    icon_class: w.icon_class, desc: w.desc, code, temp: tmax, temp_max: tmax, temp_min: 23, feels_max: tmax + 3, feels_min: 24,
    precip_sum: code === 61 ? 4.2 : 0, precip_probability: rain, wind_max: 5, gusts_max: 9, wind_direction: 220, wind_compass: 'SW', uv_max: round(9 * clear, 1),
    sunrise: new Date(dayStart + 6.25 * 3600000).toISOString(), sunset: new Date(dayStart + 18.35 * 3600000).toISOString(), daylight_hours: 12.1,
    extra: `Feels ${Math.round(tmax + 3)}°C · Rain ${rain}%` };
}

/** /api/solar-forecast */
export function solarForecast(now = Date.now()) {
  const day0 = startOfDay(now);
  const hourly = [];
  for (let i = 1; i <= 96; i++) {
    const end = day0 + i * 3600000, mid = end - 1800000;
    const pv = forecastSolarKwh(end - 3600000);
    const clear = clearness(mid), code = weatherCode(clear), isDay = clearSkySolar(hourOf(mid)) > 0;
    hourly.push({ period_end: new Date(end).toISOString(), period: 'PT60M', pv_estimate: round(pv), pv_estimate10: round(pv * 0.8), pv_estimate90: round(pv * 1.1),
      ghi: Math.round(pv / (CAPACITY_W / 1000) / 0.9 * 1000), cloud_cover: Math.round((1 - clear) * 100), air_temp: round(tempAt(mid), 1),
      precip_probability: code === 61 ? 60 : 10, weather_code: code, is_day: isDay, energy_kwh: round(pv), date: dayKey(end - 1) });
  }
  const daily = [];
  for (let d = 0; d < 7; d++) {
    const start = day0 + d * 86400000;
    let total = 0, peak = 0;
    for (let h = 0; h < 24; h++) { const e = forecastSolarKwh(start + h * 3600000); total += e; peak = Math.max(peak, e); }
    const row = { date: dayKey(start), total_kwh: round(total, 2), peak_kw: round(peak), source: 'open-meteo' };
    if (d === 0) row.actual_so_far = dayTotals(day0).solar_kwh;
    daily.push(row);
  }
  const s = liveNow(now), clear = clearness(now), code = weatherCode(clear), isDay = clearSkySolar(hourOf(now)) > 0, cur = wx(code, isDay);
  const temp = round(tempAt(now), 1), humidity = Math.round(55 + 25 * (1 - clear));
  const weather = {
    available: true, updated_at: new Date(now - 4 * 60000).toISOString(), icon_class: cur.icon_class, desc: cur.desc, code, is_day: isDay,
    temp, feels_like: round(temp + 2.5, 1), humidity, wind_speed: 3.2, wind_gusts: 6.1, wind_direction: 220, wind_compass: COMPASS[5],
    cloud_cover: Math.round((1 - clear) * 100), precip: code === 61 ? 0.4 : 0, precip_probability: code === 61 ? 60 : 10, pressure: 1011,
    uv_index: round(8 * s.solar / CAPACITY_W, 1), today: weatherDay(day0),
    sunrise: new Date(day0 + 6.25 * 3600000).toISOString(), sunset: new Date(day0 + 18.35 * 3600000).toISOString(),
    extra: `Feels ${Math.round(temp + 2.5)}°C · Humidity ${humidity}%`,
    forecast_weather: [1, 2, 3, 4, 5, 6].map(d => weatherDay(day0 + d * 86400000)),
    hourly: Array.from({ length: 24 }, (_, i) => {
      const t = Math.floor(now / 3600000) * 3600000 + i * 3600000, c = weatherCode(clearness(t)), day = clearSkySolar(hourOf(t)) > 0, w = wx(c, day);
      return { time: new Date(t).toISOString(), temp: round(tempAt(t), 1), feels_like: round(tempAt(t) + 2.5, 1), icon_class: w.icon_class, desc: w.desc, code: c,
        precip_probability: c === 61 ? 60 : 10, precip: c === 61 ? 0.4 : 0, cloud_cover: Math.round((1 - clearness(t)) * 100), wind_speed: 3.2,
        uv_index: round(8 * clearSkySolar(hourOf(t)) / CAPACITY_W, 1), is_day: day };
    })
  };
  return { daily, hourly, source: 'open-meteo', source_label: 'Open-Meteo', server_today: dayKey(now), weather, weather_source: 'open-meteo' };
}

export const publicConfig = {
  dashboard_title: 'Card showcase', dashboard_logo: '', dashboard_favicon: '', dashboard_bg_color: '', dashboard_bg_color_light: '', dashboard_bg_color_dark: '',
  dashboard_bg_image: '', transparent_blocks: '', desktop_dashboard: '', mobile_dashboard: '', savings_currency: CURRENCY, savings_rate: String(PRICES.buy), solar_capacity_kwp: '5'
};
