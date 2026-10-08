const { getConfig, getDb } = require('./database');
const { computeTodaySolar } = require('./solar');
const { localDateString } = require('./localTime');
const { readDailySnapshots } = require('./timeseriesReader');

async function getSavings() {
  const db = getDb();
  const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
  const rate = parseFloat(rateRow?.value) || 0.30;
  const currency = getConfig('savings_currency') || '€';
  const todaySolar = computeTodaySolar();

  const now = new Date();
  const todayStr = localDateString(now);

  // Week start (Monday-based)
  const dayOfWeek = now.getDay();
  const weekDiff = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - weekDiff);
  weekStart.setHours(0, 0, 0, 0);

  // Month start
  const monthStartStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  // Single query: get MAX(daily_solar) per day for week + month ranges,
  // then add today's live value. daily_solar is the running cumulative total in the history table.
  const weekStartUnix = Math.floor(weekStart.getTime() / 1000);
  const todayEndUnix = Math.floor(now.getTime() / 1000);

  const rows = readDailySnapshots(db, { from: Math.min(weekStartUnix, Math.floor(new Date(monthStartStr + 'T00:00:00').getTime() / 1000)), to: todayEndUnix, toInclusive: true, fields: ['daily_solar'] });

  // Month rows from the same data — just aggregate differently
  const monthStartUnix = Math.floor(new Date(monthStartStr + 'T00:00:00').getTime() / 1000);
  const weekRows = rows.filter(row => row.day >= localDateString(weekStart) && row.day <= todayStr).map(row => ({ day: row.day, max_solar: row.daily_solar }));
  const monthRows = rows.filter(row => row.day >= monthStartStr && row.day <= todayStr).map(row => ({ day: row.day, max_solar: row.daily_solar }));

  // Sum past days from the DB and use the live value for today (counted even
  // when no history row has been written for today yet).
  const sumWithLiveToday = (rows) => {
    let total = todaySolar;
    for (const row of rows) {
      if (row.day !== todayStr) total += row.max_solar || 0;
    }
    return total;
  };
  const weekSolar = sumWithLiveToday(weekRows);
  const monthSolar = sumWithLiveToday(monthRows);

  // All-time aggregation
  const dayRows = readDailySnapshots(db, { fields: ['daily_solar'], cached: true }).map(row => ({ day: row.day, max_solar: row.daily_solar }));
  const allTimeSolar = dayRows.reduce((sum, row) => sum + (row.max_solar || 0), 0);
  const allTimeSavings = allTimeSolar * rate;

  return {
    currency, rate,
    today: todaySolar * rate,
    week: weekSolar * rate,
    month: monthSolar * rate,
    all: allTimeSavings
  };
}

module.exports = { getSavings };
