'use strict';
/**
 * What solar saves you: each day's solar kWh times the price of the energy it
 * replaced. Settings > Prices and savings > "Solar savings" picks the price:
 *
 *  - grid (default): the grid buy price, as before;
 *  - availability: solar made while the grid was up is valued at the grid
 *    price, solar made during an outage at the generator price (what would
 *    have run instead). The split comes from the grid status history; with no
 *    grid status set up, all of it counts at the grid price;
 *  - bought: each day at the average price of the grid and generator energy
 *    bought that day; on a day neither was bought, the grid price.
 *
 * Finished days are kept for a while (they don't change); today is worked out
 * on each call.
 *
 * @module solarValue
 */
const { getConfig, getDb } = require('./database');
const { localDateString } = require('./localTime');
const { readDailySnapshots, readHistorySeries, dailyCacheGeneration } = require('./timeseriesReader');

const METHODS = ['grid', 'availability', 'bought'];
const CACHE_MS = 10 * 60 * 1000;
const MAX_RAW_GAP = 120;      // a raw sample counts for at most 2 min (gaps aren't sunshine)
const BUCKET_SECONDS = 300;

function price(key, fallback = 0) {
  const n = parseFloat(getConfig(key));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The prices and method from Settings. */
function savingsSettings() {
  const method = getConfig('savings_method');
  return {
    method: METHODS.includes(method) ? method : 'grid',
    grid: price('savings_rate', 0.30) || 0.30,
    generator: price('generator_price', 0),
    currency: getConfig('savings_currency') || '€'
  };
}

/** Grid on/off changes as [{ timestamp, state }] covering [from, to). */
function gridChanges(db, from, to) {
  const before = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(from);
  const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp').all(from, to);
  return before ? [before, ...rows] : rows;
}

/**
 * Per local day: solar energy (Wh, from power readings) made while the grid
 * was up and while it was down. Days with no grid status at all count as up.
 */
function solarByGrid(db, from, to) {
  const out = new Map();
  if (!db.prepare('SELECT 1 FROM grid_status LIMIT 1').get()) return out;
  const rows = readHistorySeries(db, { from, to, fields: ['solar'] });
  const changes = gridChanges(db, from, to);
  let c = 0, up = true;
  while (c < changes.length && changes[c].timestamp <= (rows[0] ? rows[0].timestamp : from)) { up = changes[c].state !== 0; c++; }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    while (c < changes.length && changes[c].timestamp <= row.timestamp) { up = changes[c].state !== 0; c++; }
    const watts = Number(row.solar);
    if (!Number.isFinite(watts) || watts <= 0) continue;
    const rollup = (row.solar_count || 1) > 1;
    const next = rows[i + 1] ? rows[i + 1].timestamp : Math.min(to, row.timestamp + (rollup ? BUCKET_SECONDS : MAX_RAW_GAP));
    const seconds = Math.max(0, Math.min(next - row.timestamp, rollup ? BUCKET_SECONDS : MAX_RAW_GAP));
    if (!seconds) continue;
    const day = localDateString(new Date(row.timestamp * 1000));
    let d = out.get(day);
    if (!d) { d = { up: 0, down: 0 }; out.set(day, d); }
    d[up ? 'up' : 'down'] += watts * seconds / 3600;
  }
  return out;
}

/** Price one solar kWh replaced on a day. */
function dayPrice(settings, day) {
  if (settings.method === 'availability') {
    const split = day.split;
    const total = split ? split.up + split.down : 0;
    const downShare = total > 0 ? split.down / total : 0;
    return settings.grid * (1 - downShare) + settings.generator * downShare;
  }
  if (settings.method === 'bought') {
    const grid = Math.max(0, day.daily_grid_import || 0), gen = Math.max(0, day.daily_generator || 0);
    return grid + gen > 0 ? (grid * settings.grid + gen * settings.generator) / (grid + gen) : settings.grid;
  }
  return settings.grid;
}

const FIELDS = ['daily_solar', 'daily_grid_import', 'daily_generator'];
const cache = new WeakMap();   // db -> { key, today, at, days }
const splitCache = new WeakMap();   // db -> { gen, days: Map(day -> { up, down } | null) }

/** Finished days (before `todayStart`) with their solar kWh and price inputs. */
function pastDays(db, settings, today, todayStart) {
  const key = settings.method + '|' + dailyCacheGeneration();
  const hit = cache.get(db);
  if (hit && hit.key === key && hit.today === today && Date.now() - hit.at < CACHE_MS) return hit.days;
  const days = readDailySnapshots(db, { to: todayStart, fields: FIELDS }).filter(d => d.day < today);
  if (settings.method === 'availability' && days.length) {
    // A finished day's grid up/down split doesn't change: work each one out
    // once and only scan the days not done yet (usually just yesterday).
    const gen = dailyCacheGeneration();
    let done = splitCache.get(db);
    if (!done || done.gen !== gen) { done = { gen, days: new Map() }; splitCache.set(db, done); }
    const missing = days.filter(d => !done.days.has(d.day));
    if (missing.length) {
      const from = Math.floor(new Date(missing[0].day + 'T00:00:00').getTime() / 1000);
      const split = solarByGrid(db, from, todayStart);
      for (const d of missing) done.days.set(d.day, split.get(d.day) || null);
    }
    for (const d of days) d.split = done.days.get(d.day) || null;
  }
  cache.set(db, { key, today, at: Date.now(), days });
  return days;
}

/** Forget cached days (tests, or after writing into past days). */
function clearSolarValueCache(db) { if (db) { cache.delete(db); splitCache.delete(db); } }

/**
 * Savings for today, this week (from Monday), this month and all time, plus
 * the price used today. `todaySolarKwh` is the live solar energy today.
 */
function computeSavings({ todaySolarKwh = 0, db = getDb(), now = new Date() } = {}) {
  const settings = savingsSettings();
  const today = localDateString(now);
  const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekStr = localDateString(weekStart), monthStr = localDateString(monthStart);

  const todayRow = readDailySnapshots(db, { from: todayStart, fields: FIELDS }).find(d => d.day === today) || { day: today };
  if (settings.method === 'availability') todayRow.split = solarByGrid(db, todayStart, Math.floor(now.getTime() / 1000) + 1).get(today) || null;
  const todayPrice = dayPrice(settings, todayRow);
  const todayValue = (Number(todaySolarKwh) || 0) * todayPrice;

  // As before: today/week/month use the live solar figure; all time uses
  // today's stored daily total when there is one.
  const todayStored = Number.isFinite(todayRow.daily_solar) ? todayRow.daily_solar : (Number(todaySolarKwh) || 0);
  let week = todayValue, month = todayValue, all = todayStored * todayPrice, allSolar = todayStored;
  for (const d of pastDays(db, settings, today, todayStart)) {
    const value = (d.daily_solar || 0) * dayPrice(settings, d);
    all += value; allSolar += d.daily_solar || 0;
    if (d.day >= weekStr) week += value;
    if (d.day >= monthStr) month += value;
  }
  return {
    currency: settings.currency, rate: settings.grid, generatorPrice: settings.generator,
    method: settings.method, todayPrice,
    today: todayValue, week, month, all, allTimeSolarKwh: allSolar
  };
}

module.exports = { computeSavings, savingsSettings, solarByGrid, dayPrice, clearSolarValueCache, METHODS };
