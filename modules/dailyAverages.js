'use strict';
/**
 * Average per day: the mean of a metric's daily figure over the days on record (the "Average per day"
 * combined metric, modules/combinedMetrics.js). Works on any metric, from its stored readings and the
 * 5-minute summaries that replace them after 30 days, so every day on record counts.
 *
 * A day's figure is one of (`mode`):
 *   total     the highest value of the day: the day's total of a reading that counts up through the day and
 *             starts again at midnight (Energy today, a daily kWh counter)
 *   energy    kWh worked out from a power reading (W or kW), integrated over the day
 *   average   the day's average value (voltage, temperature, a state of charge)
 *   peak      the day's highest value
 *
 * Only complete days count: today is left out unless asked for, and so is the first day on record when its
 * readings began later than an hour after midnight. A day with no readings is not a zero, it is left out.
 * Gaps in a day's readings are not filled: energy counts only what was recorded, as Energy today does.
 *
 * @module dailyAverages
 */
const { localDateString } = require('./localTime');
const { readMetricSeries } = require('./timeseriesReader');
const { dailyMetricPeaks } = require('./peaks');

const MODES = ['total', 'energy', 'average', 'peak'];
const MAX_GAP_SECONDS = 600;     // as in combinedMetrics: energy pauses across longer gaps
const MAX_DAYS = 3650;
const FIRST_DAY_GRACE = 3600;    // readings that began within an hour of midnight make a complete first day

const dayStart = (date, back = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - back);
const dayKey = ts => localDateString(new Date(ts * 1000));

/** The earliest reading time (unix s) of a metric across readings and summaries, or null. */
function firstReading(db, metric) {
  const a = db.prepare('SELECT MIN(timestamp) AS t FROM metrics WHERE metric = ?').get(metric);
  const b = db.prepare('SELECT MIN(bucket_start) AS t FROM metrics_5m WHERE metric = ?').get(metric);
  const times = [a && a.t, b && b.t].filter(t => Number.isFinite(Number(t)) && t !== null).map(Number);
  return times.length ? Math.min(...times) : null;
}

/**
 * Each local day's figure for `metric` from `from` (unix s) to `to`: Map(day -> value).
 * `inputUnit` ('W' or 'kW') applies to the energy mode.
 */
function dailyFigures(db, metric, mode, from, to, inputUnit = 'W') {
  const fromDay = dayKey(from);
  if (mode === 'total' || mode === 'peak') return dailyMetricPeaks(db, metric, from, to, fromDay);
  const series = readMetricSeries(db, { metric, from, to, toInclusive: true }).filter(r => Number.isFinite(Number(r.value)));
  const days = new Map();
  if (mode === 'average') {
    const acc = new Map();
    for (const r of series) {
      const day = dayKey(r.timestamp);
      const w = Math.max(1, Number(r.count) || 1);
      const a = acc.get(day) || { sum: 0, n: 0 };
      a.sum += Number(r.value) * w; a.n += w;
      acc.set(day, a);
    }
    for (const [day, a] of acc) days.set(day, a.sum / a.n);
    return days;
  }
  // energy: trapezoid between neighbouring readings, a gap longer than MAX_GAP_SECONDS adds nothing
  const toKw = inputUnit === 'kW' ? 1 : 0.001;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i], dt = b.timestamp - a.timestamp;
    if (!(dt > 0) || dt > MAX_GAP_SECONDS) continue;
    const kw = Math.max(0, (Number(a.value) + Number(b.value)) / 2 * toKw);
    const day = dayKey(b.timestamp);   // an interval across midnight belongs to the new day, as in Energy today
    days.set(day, (days.get(day) || 0) + kw * dt / 3600);
  }
  return days;
}

/**
 * The average per day of `def.inputs[0]`: { value, days, from, to } or { skip: reason }.
 * def: { daily, days (last N days; empty = every day on record), include_today, input_unit }.
 */
function averagePerDay(db, def, now = new Date()) {
  const metric = String((def.inputs || [])[0] || '').trim();
  if (!metric) return { skip: 'no input' };
  const mode = MODES.includes(def.daily) ? def.daily : 'total';
  const includeToday = def.include_today === true;
  const first = firstReading(db, metric);
  if (first === null) return { skip: `${metric} has no readings yet` };
  const today = localDateString(now);
  const limit = Number(def.days) > 0 ? Math.min(MAX_DAYS, Math.floor(Number(def.days))) : 0;
  // The window: the last `limit` complete days (or that many ending today), or everything on record.
  const lastDate = includeToday ? dayStart(now) : dayStart(now, 1);
  let fromDate = limit ? dayStart(lastDate, limit - 1) : new Date(first * 1000);
  fromDate = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const from = Math.floor(fromDate.getTime() / 1000);
  const to = Math.floor(now.getTime() / 1000) + 1;
  const figures = dailyFigures(db, metric, mode, from, to, def.input_unit === 'kW' ? 'kW' : 'W');
  const firstDay = dayKey(first), midnight = Math.floor(new Date(Number(firstDay.slice(0, 4)), Number(firstDay.slice(5, 7)) - 1, Number(firstDay.slice(8, 10))).getTime() / 1000);
  const partialFirst = first - midnight > FIRST_DAY_GRACE;
  const values = [];
  let fromDay = null, toDay = null;
  for (const [day, v] of [...figures.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!Number.isFinite(v)) continue;
    if (day === today && !includeToday) continue;
    if (day === firstDay && partialFirst) continue;
    values.push(v);
    fromDay = fromDay || day; toDay = day;
  }
  if (!values.length) return { skip: 'no complete days of readings yet' };
  const value = values.reduce((a, b) => a + b, 0) / values.length;
  return { value: Math.round(value * 1000) / 1000, days: values.length, from: fromDay, to: toDay };
}

module.exports = { averagePerDay, dailyFigures, firstReading, MODES, MAX_DAYS };
