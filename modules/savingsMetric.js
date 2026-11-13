'use strict';
/**
 * Today's savings as a metric, `savings_today` (in the currency set in Settings > Prices and savings, no unit), so any
 * card, chart or notification can show "Saved today" (the Meter tile card, for one). It is the same figure as the
 * Savings card's "today". Publishing is at most once a minute and can never break the poll.
 *
 * @module savingsMetric
 */
const { logger } = require('./logger');

const METRIC = 'savings_today';
const MIN_INTERVAL_MS = 60 * 1000;
let lastAt = 0;

/** Publish today's savings. Returns the figure published, or null (too soon, or nothing to publish). */
function publishSavingsToday(now = Date.now()) {
  if (now - lastAt < MIN_INTERVAL_MS) return null;
  lastAt = now;   // also after a failure, so a broken calculation is tried once a minute and not every poll
  try {
    const { computeSavings } = require('./solarValue');
    const { computeTodaySolar } = require('./solar');
    const today = Number(computeSavings({ todaySolarKwh: computeTodaySolar() }).today);
    if (!Number.isFinite(today)) return null;
    const value = Math.round(today * 100) / 100;
    require('./database').queueMetricValue(METRIC, value, Math.floor(now / 1000), '');
    return value;
  } catch (e) {
    logger.debug(`[savings] could not publish today's savings: ${e.message}`);
    return null;
  }
}

module.exports = { publishSavingsToday, METRIC, resetSavingsMetric: () => { lastAt = 0; } };
