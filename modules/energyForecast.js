'use strict';
/**
 * Hourly forecasts for one local day, in kWh per hour:
 *
 * - Consumption: for each hour of the day, the same hour on the previous
 *   14 days. The median is the forecast; the 20th to 80th percentile is the
 *   likely range. An hour needs at least 3 days with data.
 * - Base load: the 10th percentile of every hour in those 14 days, i.e.
 *   what the home uses when almost nothing is on. Same for every hour.
 * - Solar: the solar forecast (Solcast or Open-Meteo) summed into hours,
 *   with its P10-P90 band as the likely range.
 *
 * Consumption forecasts are cached per date for 30 minutes; computing one
 * reads 14 days of history.
 *
 * @module energyForecast
 */

const { readHourlyEnergy, hourStarts } = require('./energyHourly');
const { periodHours } = require('./solar');

const HISTORY_DAYS = 14;
const MIN_DAYS = 3;
const MIN_COVERAGE = 0.8;
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map(); // date -> { at, value }

const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Linear-interpolated percentile (0-100) of a numeric array. */
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), i = (s.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number), t = new Date(y, m - 1, d + days, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** Consumption forecast and base load for `date`, from the 14 days before it. */
function consumptionForecast(db, date, { now = Math.floor(Date.now() / 1000), days = HISTORY_DAYS } = {}) {
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const byHour = Array.from({ length: 24 }, () => []), everyHour = [];
  let daysWithData = 0;
  for (let back = 1; back <= days; back++) {
    const day = readHourlyEnergy(db, { date: shiftDate(date, -back), now });
    let any = false;
    for (const h of day.hours) {
      if (h.coverage < MIN_COVERAGE) continue;
      any = true;
      const kwh = h.energy.consumption / h.coverage; // scale a partly covered hour up to a full hour
      byHour[new Date(h.start * 1000).getHours()].push(kwh);
      everyHour.push(kwh);
    }
    if (any) daysWithData++;
  }
  const value = {
    days: daysWithData,
    baseLoad: daysWithData >= MIN_DAYS ? round(percentile(everyHour, 10)) : null,
    hours: byHour.map(v => (v.length >= MIN_DAYS ? { expected: round(percentile(v, 50)), low: round(percentile(v, 20)), high: round(percentile(v, 80)), samples: v.length } : null))
  };
  cache.set(date, { at: Date.now(), value });
  return value;
}

/** Solar forecast periods summed into the hours starting at `starts` (kWh). */
function solarByHour(periods, starts) {
  const hours = starts.slice(0, -1).map(() => ({ expected: 0, low: 0, high: 0, n: 0 }));
  for (const p of periods || []) {
    const end = Date.parse(p.period_end) / 1000, len = periodHours(p);
    if (!Number.isFinite(end) || !(len > 0)) continue;
    const mid = end - len * 1800;
    const i = starts.findIndex((s, k) => k < starts.length - 1 && mid >= s && mid < starts[k + 1]);
    if (i < 0) continue;
    const kw = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const h = hours[i];
    h.expected += kw(p.pv_estimate) * len;
    h.low += kw(p.pv_estimate10 ?? p.pv_estimate) * len;
    h.high += kw(p.pv_estimate90 ?? p.pv_estimate) * len;
    h.n++;
  }
  return hours.map(h => (h.n ? { expected: round(h.expected), low: round(h.low), high: round(h.high) } : null));
}

function sumRange(list) {
  const present = list.filter(Boolean);
  if (!present.length) return null;
  return ['expected', 'low', 'high'].reduce((o, k) => (o[k] = round(present.reduce((a, x) => a + x[k], 0), 2), o), {});
}

/**
 * Forecast for each hour of `date`, lined up with readHourlyEnergy's hours.
 * @param solarForecast the object getSolarForecast() returns, or null
 */
function hourlyForecast(db, { date, solarForecast = null, now = Math.floor(Date.now() / 1000) }) {
  const starts = hourStarts(date);
  const cons = consumptionForecast(db, date, { now });
  const solar = solarForecast && !solarForecast.error ? solarByHour(solarForecast.hourly, starts) : starts.slice(0, -1).map(() => null);
  const hours = starts.slice(0, -1).map((start, i) => ({
    start,
    consumption: cons.hours[new Date(start * 1000).getHours()],
    baseLoad: cons.baseLoad,
    solar: solar[i]
  }));
  return {
    historyDays: cons.days,
    source: solarForecast && !solarForecast.error ? (solarForecast.source || null) : null,
    hours,
    day: { consumption: sumRange(hours.map(h => h.consumption)), solar: sumRange(hours.map(h => h.solar)) }
  };
}

function clearForecastCache() { cache.clear(); }

module.exports = { hourlyForecast, consumptionForecast, solarByHour, percentile, clearForecastCache };
