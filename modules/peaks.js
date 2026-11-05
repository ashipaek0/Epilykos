'use strict';
/**
 * Daily peaks and histograms of solar power (and of any metric's daily highest),
 * for the Daily peak and Histogram cards.
 *
 *   dailySolarPeaks       the highest solar power (W) of each local day, from the stored readings
 *                         (history) and the 5-minute summaries that replace them after 30 days, so
 *                         every day on record has a peak without any setup
 *   dailyMetricPeaks      the highest value of any metric per local day, from its stored readings and
 *                         5-minute summaries; for a "Highest today" combined metric (a running peak
 *                         that restarts at midnight) this is that day's peak
 *   solarPowerSamples     the average solar power of each 5 minutes (W), for "time at each power level"
 *   histogram             values (or weighted values) in tidy bands: widths of 1, 2, 2.5 or 5 times a
 *                         power of ten, so the edges read as round numbers
 *
 * Days are local days, grouped from 15-minute parts the way modules/timeseriesReader.js does.
 *
 * @module peaks
 */
const { localDateString } = require('./localTime');

const PART = 900;            // 15 minutes
const BUCKET = 300;          // the rollup's bucket
const NIGHT_WATTS = 10;      // below this a 5-minute average counts as night

const dayOfPart = part => localDateString(new Date(part * PART * 1000));

/** Reduce 15-minute parts to the highest value per local day: Map(day -> max). */
function maxPerDay(rows, fromDay) {
  const days = new Map();
  for (const r of rows) {
    const v = Number(r.v);
    if (!Number.isFinite(v)) continue;
    const day = dayOfPart(r.part);
    if (day < fromDay) continue;
    if (!days.has(day) || v > days.get(day)) days.set(day, v);
  }
  return days;
}

function dailySolarPeaks(db, from, to, fromDay) {
  const rows = db.prepare(`SELECT part, MAX(v) AS v FROM (
      SELECT timestamp / ${PART} AS part, solar AS v FROM history WHERE timestamp >= @from AND timestamp < @to AND solar IS NOT NULL
      UNION ALL
      SELECT bucket_start / ${PART} AS part, solar_max AS v FROM history_5m WHERE bucket_start >= @fromBucket AND bucket_start < @to AND solar_max IS NOT NULL
    ) GROUP BY part`).all({ from, to, fromBucket: from - BUCKET });
  return maxPerDay(rows, fromDay);
}

function dailyMetricPeaks(db, metric, from, to, fromDay) {
  const rows = db.prepare(`SELECT part, MAX(v) AS v FROM (
      SELECT timestamp / ${PART} AS part, value AS v FROM metrics WHERE metric = @metric AND timestamp >= @from AND timestamp < @to AND value IS NOT NULL
      UNION ALL
      SELECT bucket_start / ${PART} AS part, value_max AS v FROM metrics_5m WHERE metric = @metric AND bucket_start >= @fromBucket AND bucket_start < @to AND value_max IS NOT NULL
    ) GROUP BY part`).all({ metric, from, to, fromBucket: from - BUCKET });
  return maxPerDay(rows, fromDay);
}

/** The last `days` local days (oldest first, today last) with each day's peak or null. */
function peaksSeries(peaks, days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    const day = localDateString(d);
    out.push({ day, value: peaks.has(day) ? peaks.get(day) : null });
  }
  return out;
}

/** [from (unix s), fromDay] for a window of `days` local days ending today. */
function windowOf(days, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: Math.floor(start.getTime() / 1000), fromDay: localDateString(start) };
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** The average solar power (W) of each 5 minutes in [from, to); night (under 10 W) left out unless asked for. */
function solarPowerSamples(db, from, to, { includeNight = false } = {}) {
  const raw = new Map();
  for (const r of db.prepare(`SELECT timestamp / ${BUCKET} AS b, AVG(solar) AS a FROM history WHERE timestamp >= ? AND timestamp < ? AND solar IS NOT NULL GROUP BY b`).all(from, to)) raw.set(r.b, r.a);
  const samples = [...raw.values()];
  for (const r of db.prepare('SELECT bucket_start / ? AS b, solar_avg AS a FROM history_5m WHERE bucket_start >= ? AND bucket_start < ? AND solar_avg IS NOT NULL AND solar_count > 0').all(BUCKET, from - BUCKET, to)) {
    if (!raw.has(r.b) && r.b * BUCKET >= from) samples.push(r.a);
  }
  return includeNight ? samples : samples.filter(w => w >= NIGHT_WATTS);
}

/** A tidy band width: 1, 2, 2.5 or 5 times a power of ten, giving about `target` bands over `range`. */
function niceStep(range, target) {
  if (!(range > 0) || !(target > 0)) return 1;
  const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

const clean = n => Number(n.toPrecision(12));

/**
 * Count values into bands about `bins` wide in total. Bands start at a round number at or below the
 * lowest value (`fromZero` starts them at 0); the last band includes its upper edge.
 * Returns { step, bins: [{ from, to, count }], total } with count scaled by `weight` per value.
 */
function histogram(values, { bins = 10, fromZero = false, weight = 1 } = {}) {
  const v = values.filter(x => Number.isFinite(x) && x >= 0);
  if (!v.length) return { step: 0, bins: [], total: 0 };
  const max = Math.max(...v), min = fromZero ? 0 : Math.min(...v);
  const step = niceStep(max - min, Math.min(40, Math.max(2, bins)));
  const start = fromZero ? 0 : Math.floor(min / step) * step;
  const count = Math.max(1, Math.ceil((max - start) / step - 1e-9));
  const out = Array.from({ length: count }, (_, i) => ({ from: clean(start + i * step), to: clean(start + (i + 1) * step), count: 0 }));
  for (const x of v) out[Math.min(count - 1, Math.max(0, Math.floor((x - start) / step + 1e-9)))].count += weight;
  return { step: clean(step), bins: out.map(b => ({ ...b, count: clean(b.count) })), total: clean(v.length * weight) };
}

module.exports = { dailySolarPeaks, dailyMetricPeaks, peaksSeries, windowOf, median, solarPowerSamples, histogram, niceStep, NIGHT_WATTS };
