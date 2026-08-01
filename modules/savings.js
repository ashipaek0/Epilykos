const { logger } = require('./logger');
const { getConfig, getDb } = require('./database');
const { computeTodaySolar } = require('./solar');

async function getSavings() {
  const db = getDb();
  const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
  const rate = parseFloat(rateRow?.value) || 0.30;
  const currency = getConfig('savings_currency') || '€';
  const todaySolar = computeTodaySolar();

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA');

  // Week start (Monday-based)
  const dayOfWeek = now.getDay();
  const weekDiff = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - weekDiff);
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toLocaleDateString('en-CA');

  // Month start
  const monthStartStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  // Single query: get MAX(daily_solar) per day for week + month ranges,
  // then add today's live value. daily_solar is the running cumulative total in the history table.
  const weekStartUnix = Math.floor(weekStart.getTime() / 1000);
  const todayEndUnix = Math.floor(now.getTime() / 1000);

  const weekRows = db.prepare(`
    SELECT date(timestamp, 'unixepoch') AS day, MAX(daily_solar) AS max_solar
    FROM history WHERE timestamp >= ? AND timestamp <= ? AND daily_solar IS NOT NULL
    GROUP BY day ORDER BY day ASC
  `).all(weekStartUnix, todayEndUnix);

  // Month rows from the same data — just aggregate differently
  const monthStartUnix = Math.floor(new Date(monthStartStr + 'T00:00:00').getTime() / 1000);
  const monthRows = db.prepare(`
    SELECT date(timestamp, 'unixepoch') AS day, MAX(daily_solar) AS max_solar
    FROM history WHERE timestamp >= ? AND timestamp <= ? AND daily_solar IS NOT NULL
    GROUP BY day ORDER BY day ASC
  `).all(monthStartUnix, todayEndUnix);

  // Compute week total: sum past days from DB, use live value for today
  let weekSolar = 0;
  for (const row of weekRows) {
    if (row.day === todayStr) {
      weekSolar += todaySolar;
    } else {
      weekSolar += row.max_solar || 0;
    }
  }

  // Compute month total similarly
  let monthSolar = 0;
  for (const row of monthRows) {
    if (row.day === todayStr) {
      monthSolar += todaySolar;
    } else {
      monthSolar += row.max_solar || 0;
    }
  }

  // All-time aggregation
  const dayRows = db.prepare(`SELECT date(timestamp, 'unixepoch') AS day, MAX(daily_solar) AS max_solar FROM history WHERE daily_solar IS NOT NULL GROUP BY day ORDER BY day ASC`).all();
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
