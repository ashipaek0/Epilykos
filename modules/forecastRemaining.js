'use strict';
/**
 * The solar still expected today (and the whole day's expected total): the sum of the forecast's energy for the periods that have not ended yet (the one in
 * progress counts for the part that is left), published as the metric `forecast_solar_remaining` (kWh) so any card,
 * chart, notification or combined metric can use it ("Remaining solar today").
 *
 * Works on the forecast payload (`hourly`: periods with period_end, an optional ISO period such as PT30M, and pv_estimate in
 * kW), whatever supplied it. Publishing is at most once a minute and can never break the forecast.
 *
 * @module forecastRemaining
 */
const { localDateString } = require('./localTime');
const { logger } = require('./logger');

const METRIC = 'forecast_solar_remaining';
const TODAY_METRIC = 'forecast_solar_today';
const MIN_INTERVAL_MS = 60 * 1000;
let lastAt = 0;
let dayTotal = { day: '', complete: false };   // the day's expected total last published, and whether it was worked out from the whole day
const COMPLETE_BY_HOUR = 9;                       // a forecast with a period ending by this hour of the day still has the morning in it

const endMs = p => { const t = new Date(p && p.period_end).getTime(); return Number.isFinite(t) ? t : null; };
function hoursOf(p) {
  const m = /^PT(\d+(?:\.\d+)?)([HM])$/i.exec(String((p && p.period) || ''));
  if (!m) return 1;
  return m[2].toUpperCase() === 'H' ? Number(m[1]) : Number(m[1]) / 60;
}

/** kWh still expected today from `periods` at `now` (ms), or null when no period of today is still ahead. */
function remainingKwh(periods, now = Date.now()) {
  if (!Array.isArray(periods)) return null;
  const today = localDateString(new Date(now));
  let kwh = 0, seen = false;
  for (const p of periods) {
    const end = endMs(p);
    const pv = p && p.pv_estimate != null && p.pv_estimate !== '' ? Number(p.pv_estimate) : NaN;
    if (end === null || !Number.isFinite(pv) || end <= now || localDateString(new Date(end)) !== today) continue;
    const h = hoursOf(p), len = h * 3600000;
    kwh += Math.max(0, pv) * h * (end - len >= now ? 1 : (end - now) / len);
    seen = true;
  }
  return seen ? Math.round(kwh * 100) / 100 : null;
}

/** kWh expected over the whole of today from `periods` (the periods that end today, ended or not), or null when none does. */
function todayKwh(periods, now = Date.now()) {
  if (!Array.isArray(periods)) return null;
  const today = localDateString(new Date(now));
  let kwh = 0, seen = false;
  for (const p of periods) {
    const end = endMs(p);
    const pv = p && p.pv_estimate != null && p.pv_estimate !== '' ? Number(p.pv_estimate) : NaN;
    if (end === null || !Number.isFinite(pv) || localDateString(new Date(end - 1)) !== today) continue;   // a period ending at midnight belongs to the day it covers
    kwh += Math.max(0, pv) * hoursOf(p);
    seen = true;
  }
  return seen ? Math.round(kwh * 100) / 100 : null;
}

/** Publish the remaining solar from a forecast payload. Returns the kWh published, or null. */
function publishForecastRemaining(result, now = Date.now()) {
  if (!result || now - lastAt < MIN_INTERVAL_MS) return null;
  const kwh = remainingKwh(result.hourly, now);
  if (kwh === null) return null;
  lastAt = now;
  try {
    const db = require('./database');
    db.queueMetricValue(METRIC, kwh, Math.floor(now / 1000), 'kWh');
    // The day's total is only worked out from a forecast that still has the morning in it; a later forecast that starts after
    // it would understate the day, so the total published earlier today stays.
    const total = todayKwh(result.hourly, now), today = localDateString(new Date(now));
    const complete = total !== null && result.hourly.some(p => { const e = endMs(p); return e !== null && localDateString(new Date(e - 1)) === today && new Date(e).getHours() + new Date(e).getMinutes() / 60 <= COMPLETE_BY_HOUR; });
    if (total !== null && (complete || dayTotal.day !== today)) {
      db.queueMetricValue(TODAY_METRIC, total, Math.floor(now / 1000), 'kWh');
      dayTotal = { day: today, complete };
    }
  }
  catch (e) { logger.debug(`[forecast] could not publish the remaining solar: ${e.message}`); }
  return kwh;
}

module.exports = { remainingKwh, todayKwh, publishForecastRemaining, METRIC, TODAY_METRIC, resetForecastRemaining: () => { lastAt = 0; dayTotal = { day: '', complete: false }; } };
