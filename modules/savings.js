const { computeTodaySolar } = require('./solar');
const { computeSavings } = require('./solarValue');

/**
 * Solar savings for the dashboard (today, week from Monday, month, all time).
 * How each kWh is valued (grid price, by grid availability, or by what was
 * bought) is set in Settings > Prices and savings; see modules/solarValue.js.
 */
async function getSavings() {
  const s = computeSavings({ todaySolarKwh: computeTodaySolar() });
  return {
    currency: s.currency, rate: s.rate, generatorPrice: s.generatorPrice, method: s.method, todayPrice: s.todayPrice,
    today: s.today, week: s.week, month: s.month, all: s.all
  };
}

module.exports = { getSavings };
