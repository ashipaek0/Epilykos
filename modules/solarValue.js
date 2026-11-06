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
 * A finished day's value is kept (savings_daily) at the prices in force when it
 * was counted, so changing the prices or the method re-values today and the days
 * to come, not the past. "Recalculate history" counts every day again. Today is
 * worked out on each call.
 *
 * @module solarValue
 */
const { getConfig, setConfig, getDb } = require('./database');
const { logger } = require('./logger');
const { localDateString } = require('./localTime');
const { readDailySnapshots, readHistorySeries } = require('./timeseriesReader');

const METHODS = ['grid', 'availability', 'bought'];
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
// A finished day is counted (and its value kept) this long after midnight, so a source that reports late
// still lands in it. Until then it is worked out on each call, at the current prices.
const FREEZE_AFTER_MS = 3 * 3600 * 1000;
const FROZEN_KEY = 'savings_frozen_through';   // days before this date are in savings_daily

const dayStartSeconds = day => Math.floor(new Date(day + 'T00:00:00').getTime() / 1000);

/** Days in [fromDay, toStart) that have a total, with what their price needs (counters, availability split). */
function daysBetween(db, settings, fromDay, toStart, today) {
  const options = { to: toStart, fields: FIELDS };
  if (fromDay) options.from = dayStartSeconds(fromDay);
  const days = readDailySnapshots(db, options).filter(d => d.day < today && (!fromDay || d.day >= fromDay));
  if (settings.method === 'availability' && days.length) {
    const split = solarByGrid(db, dayStartSeconds(days[0].day), toStart);
    for (const d of days) d.split = split.get(d.day) || null;
  }
  return days;
}

/**
 * Count the days that are over: work out each one's value at the prices in force now and keep it in
 * savings_daily, so later changes to the prices or the method only touch today and the days to come.
 * Days before the returned date are kept; the first run counts all history at the current settings.
 */
function freezeFinishedDays(db, settings, now) {
  const cut = localDateString(new Date(now.getTime() - FREEZE_AFTER_MS));
  const through = getConfig(FROZEN_KEY) || '';
  if (through >= cut) return through;
  const days = daysBetween(db, settings, through || null, dayStartSeconds(cut), cut);
  const insert = db.prepare('INSERT OR REPLACE INTO savings_daily (day, kwh, price, value, method) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const d of days) {
      const kwh = d.daily_solar || 0, p = dayPrice(settings, d);
      insert.run(d.day, kwh, p, kwh * p, settings.method);
    }
    setConfig(FROZEN_KEY, cut);
  })();
  if (days.length) logger.info(`[savings] Counted ${days.length} finished day${days.length === 1 ? '' : 's'} at the current prices`);
  return cut;
}

/**
 * Forget every finished day's kept value; the next call counts them all again at the current prices
 * (Settings > Prices and savings > Recalculate history).
 */
function recalculateSavingsHistory(db = getDb()) {
  db.transaction(() => {
    db.prepare('DELETE FROM savings_daily').run();
    setConfig(FROZEN_KEY, '');
  })();
}

/**
 * Savings for today, this week (from Monday), this month, this year and all time, plus
 * the price used today. `todaySolarKwh` is the live solar energy today. Finished days keep the
 * value they had when they were counted (see freezeFinishedDays); today is worked out now.
 */
function computeSavings({ todaySolarKwh = 0, db = getDb(), now = new Date() } = {}) {
  const settings = savingsSettings();
  const today = localDateString(now);
  const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekStr = localDateString(weekStart), monthStr = localDateString(monthStart);
  const yearStr = localDateString(new Date(now.getFullYear(), 0, 1));

  const todayRow = readDailySnapshots(db, { from: todayStart, fields: FIELDS }).find(d => d.day === today) || { day: today };
  if (settings.method === 'availability') todayRow.split = solarByGrid(db, todayStart, Math.floor(now.getTime() / 1000) + 1).get(today) || null;
  const todayPrice = dayPrice(settings, todayRow);
  const todayValue = (Number(todaySolarKwh) || 0) * todayPrice;

  // As before: today/week/month/year use the live solar figure; all time uses
  // today's stored daily total when there is one.
  const todayStored = Number.isFinite(todayRow.daily_solar) ? todayRow.daily_solar : (Number(todaySolarKwh) || 0);
  let week = todayValue, month = todayValue, year = todayValue, all = todayStored * todayPrice, allSolar = todayStored;
  const add = (day, kwh, value) => {
    all += value; allSolar += kwh;
    if (day >= weekStr) week += value;
    if (day >= monthStr) month += value;
    if (day >= yearStr) year += value;
  };

  let through = '';
  try { through = freezeFinishedDays(db, settings, now); }
  catch (err) { logger.warn(`[savings] Could not keep the finished days' values (${err.message}); working them out each time`); through = getConfig(FROZEN_KEY) || ''; }
  try { for (const d of db.prepare('SELECT day, kwh, value FROM savings_daily').all()) add(d.day, d.kwh, d.value); }
  catch (err) { through = ''; all = todayStored * todayPrice; allSolar = todayStored; week = month = year = todayValue; }
  // Days that are over but not counted yet (the first hours after midnight, or the counting failed): at the current prices.
  if (through < today) {
    for (const d of daysBetween(db, settings, through || null, todayStart, today)) {
      const kwh = d.daily_solar || 0;
      add(d.day, kwh, kwh * dayPrice(settings, d));
    }
  }
  return {
    currency: settings.currency, rate: settings.grid, generatorPrice: settings.generator,
    method: settings.method, todayPrice,
    today: todayValue, week, month, year, all, allTimeSolarKwh: allSolar
  };
}

module.exports = { computeSavings, savingsSettings, solarByGrid, dayPrice, recalculateSavingsHistory, METHODS };
