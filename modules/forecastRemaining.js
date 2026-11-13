'use strict';
/**
 * The solar still expected today: the sum of the forecast's energy for the periods that have not ended yet (the one in
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
const MIN_INTERVAL_MS = 60 * 1000;
let lastAt = 0;

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

/** Publish the remaining solar from a forecast payload. Returns the kWh published, or null. */
function publishForecastRemaining(result, now = Date.now()) {
  if (!result || now - lastAt < MIN_INTERVAL_MS) return null;
  const kwh = remainingKwh(result.hourly, now);
  if (kwh === null) return null;
  lastAt = now;
  try { require('./database').queueMetricValue(METRIC, kwh, Math.floor(now / 1000), 'kWh'); }
  catch (e) { logger.debug(`[forecast] could not publish the remaining solar: ${e.message}`); }
  return kwh;
}

module.exports = { remainingKwh, publishForecastRemaining, METRIC, resetForecastRemaining: () => { lastAt = 0; } };
