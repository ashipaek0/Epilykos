/**
 * barCardLogic — shared band engine + bucketing for the single-metric
 * vertical bar card (`bar-single`). Slice 1 scope: single metric only,
 * no stacked bars, no thresholds.
 *
 * This module intentionally has ZERO imports so fixtures can load it via a
 * `data:` URL ES module (same pattern as textMetricCard.js).
 *
 * History shape in: [{ timestamp: <ms epoch>, value: <number|string> }, ...]
 * (see modules/metrics.js getMetricHistory — seconds converted to ms).
 *
 * DOM cap: at most MAX_BARS (200) bar elements per card. When a
 * range/bucket combination would exceed that, the bucket is coarsened
 * (doubled until the bar count fits) — see bucketizeCapped().
 */

export const MAX_BARS = 200;

/** Warm palette: stone -> amber -> deep-green (4 stops). */
export const WARM_PALETTE = ['#a8a29e', '#f59e0b', '#b45309', '#166534'];

export const RANGE_HOURS = { '24h': 24, '7d': 168 };
export const BUCKET_MS = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '1d': 24 * 60 * 60 * 1000 };

export const DEFAULT_RANGE = '24h';
export const DEFAULT_BUCKET = '1h';

/** Validate a range key ('24h'|'7d'); anything else falls back to '24h'. */
export function normalizeRange(range) {
  return Object.prototype.hasOwnProperty.call(RANGE_HOURS, range) ? range : DEFAULT_RANGE;
}

/** Validate a bucket key ('15m'|'1h'|'1d'); anything else falls back to '1h'. */
export function normalizeBucket(bucket) {
  return Object.prototype.hasOwnProperty.call(BUCKET_MS, bucket) ? bucket : DEFAULT_BUCKET;
}

/** Hours of history to fetch for a range key. */
export function rangeToHours(range) {
  return RANGE_HOURS[normalizeRange(range)];
}

/** Milliseconds per bucket for a bucket key. */
export function bucketToMs(bucket) {
  return BUCKET_MS[normalizeBucket(bucket)];
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function aggregate(vals, agg) {
  if (!vals.length) return null;
  switch (agg) {
    case 'sum': return vals.reduce((a, b) => a + b, 0);
    case 'min': return Math.min.apply(null, vals);
    case 'max': return Math.max.apply(null, vals);
    case 'last': return vals[vals.length - 1];
    case 'avg':
    default: return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
}

/**
 * Group history points into fixed-width time buckets.
 * @param {Array} points - [{ timestamp (ms epoch), value }, ...]; non-numeric values skipped
 * @param {number} bucketMs - bucket width in ms; invalid values fall back to 1h
 * @param {string} [agg='avg'] - 'avg'|'sum'|'min'|'max'|'last'
 * @returns {Array<{t:number,value:number}>} sorted by bucket start; empty input -> []
 */
export function bucketize(points, bucketMs, agg) {
  if (!Array.isArray(points) || !points.length) return [];
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) bucketMs = BUCKET_MS[DEFAULT_BUCKET];
  const mode = agg || 'avg';
  const groups = new Map();
  for (const p of points) {
    if (!p || !Number.isFinite(p.timestamp)) continue;
    const n = toNumber(p.value);
    if (n === null) continue;
    const key = Math.floor(p.timestamp / bucketMs) * bucketMs;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const out = [];
  for (const [t, vals] of groups) {
    const v = aggregate(vals, mode);
    if (v !== null && Number.isFinite(v)) out.push({ t: t, value: v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Bucket with the DOM cap applied: while the bar count exceeds MAX_BARS the
 * bucket width is doubled (documented coarsening rule).
 * @returns {{ bars:Array, bucketMs:number, coarsened:boolean }}
 */
export function bucketizeCapped(points, bucketMs, agg) {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) bucketMs = BUCKET_MS[DEFAULT_BUCKET];
  let bars = bucketize(points, bucketMs, agg);
  let coarsened = false;
  let ms = bucketMs;
  while (bars.length > MAX_BARS) {
    ms *= 2;
    coarsened = true;
    bars = bucketize(points, ms, agg);
    if (ms > 366 * 24 * 60 * 60 * 1000) break; // sanity guard, never infinite
  }
  return { bars: bars, bucketMs: ms, coarsened: coarsened };
}

/**
 * Resolve a value to a band colour.
 * @param {number} value - bucket value
 * @param {Array<{to:number,color:string}>} bands - ascending `to` limits
 * @returns {string} first band with to >= value, else the last band's colour; '' when bands/value are nullish
 */
export function resolveBand(value, bands) {
  if (value === null || value === undefined) return '';
  const n = toNumber(value);
  if (n === null) return '';
  if (!Array.isArray(bands) || !bands.length) return '';
  for (const b of bands) {
    if (!b) continue;
    const to = toNumber(b.to);
    if (to === null) continue;
    if (n <= to) return b.color || '';
  }
  return (bands[bands.length - 1] && bands[bands.length - 1].color) || '';
}

/**
 * Percentile bands: terciles (33rd / 66th percentile + max) of the
 * visible-range values, coloured from the warm palette.
 * @param {Array<number>} values - visible-range bucket values
 * @param {Array<string>} [palette] - defaults to WARM_PALETTE
 * @returns {Array<{to:number,color:string}>} 3 bands; [] when no numeric values
 */
export function percentileBands(values, palette) {
  const pal = Array.isArray(palette) && palette.length >= 3 ? palette : WARM_PALETTE;
  const nums = (Array.isArray(values) ? values : []).map(toNumber).filter(function (v) { return v !== null; });
  if (!nums.length) return [];
  nums.sort(function (a, b) { return a - b; });
  const at = function (q) { return nums[Math.min(nums.length - 1, Math.floor(nums.length * q))]; };
  const t1 = at(1 / 3);
  const t2 = at(2 / 3);
  const mx = nums[nums.length - 1];
  return [
    { to: t1, color: pal[0] },
    { to: t2, color: pal[1] },
    { to: mx, color: pal[2] }
  ];
}
