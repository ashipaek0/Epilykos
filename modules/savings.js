const { logger } = require('./logger');
const { getConfig, getDb } = require('./database');
const { computeTodaySolar, computeSolarForDate } = require('./solar');

async function getSavings() {
  const db = getDb();
  const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
  const rate = parseFloat(rateRow?.value) || 0.30;
  const currency = getConfig('savings_currency') || '€';
  const todaySolar = computeTodaySolar();
  const todaySavings = todaySolar * rate;

  const weekSolar = (() => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diff);
    weekStart.setHours(0,0,0,0);
    let total = 0;
    const loopDate = new Date(weekStart);
    const todayStr = now.toLocaleDateString('en-CA');
    while (loopDate.toLocaleDateString('en-CA') <= todayStr) {
      const dateStr = loopDate.toLocaleDateString('en-CA');
      total += (dateStr === todayStr) ? computeTodaySolar() : computeSolarForDate(dateStr);
      loopDate.setDate(loopDate.getDate() + 1);
    }
    return total;
  })();
  const monthSolar = (() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let total = 0;
    const loopDate = new Date(monthStart);
    const todayStr = now.toLocaleDateString('en-CA');
    while (loopDate.toLocaleDateString('en-CA') <= todayStr) {
      const dateStr = loopDate.toLocaleDateString('en-CA');
      total += (dateStr === todayStr) ? computeTodaySolar() : computeSolarForDate(dateStr);
      loopDate.setDate(loopDate.getDate() + 1);
    }
    return total;
  })();

  let allTimeSavings;
  const overrideValStr = getConfig('all_time_pv_savings_override');
  if (overrideValStr && !isNaN(parseFloat(overrideValStr))) {
    allTimeSavings = parseFloat(overrideValStr);
  } else {
    const allTimeRows = db.prepare(`SELECT timestamp, daily_solar FROM history WHERE daily_solar IS NOT NULL ORDER BY timestamp ASC`).all();
    const allDailyMax = {};
    allTimeRows.forEach(row => {
      const date = new Date(row.timestamp * 1000).toLocaleDateString('en-CA');
      const val = row.daily_solar;
      if (!allDailyMax[date] || val > allDailyMax[date]) allDailyMax[date] = val;
    });
    const allTimeSolar = Object.values(allDailyMax).reduce((sum, val) => sum + val, 0);
    allTimeSavings = allTimeSolar * rate;
  }

  return { currency, today: todaySavings, week: weekSolar * rate, month: monthSolar * rate, all: allTimeSavings };
}

module.exports = { getSavings };
