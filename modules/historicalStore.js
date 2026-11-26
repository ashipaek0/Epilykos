'use strict';
/**
 * Store readings from the past that come from somewhere else (an InfluxDB the user already had), in the same tables the
 * dashboard's own readings use, so every chart, report and total sees them without knowing where they came from.
 *
 *   older than the raw retention (30 days)  → metrics_5m, as 5-minute buckets (mean, min, max, count)
 *   within it                                → metrics, as raw readings
 *
 * The dashboard's own readings always win: an imported reading is skipped when the dashboard already has a reading of that
 * metric in the same 5-minute bucket (raw or rolled up). That keeps the two from interleaving where both cover the same time,
 * and makes an import safe to run again: what it stored the first time now counts as already there.
 *
 * Numbers only: a text or boolean reading has no 5-minute form and is skipped.
 *
 * @module historicalStore
 */

const { BUCKET_SECONDS, RETENTION_SECONDS } = require('./timeseriesReader');

const bucketOf = t => Math.floor(t / BUCKET_SECONDS) * BUCKET_SECONDS;
const isName = m => typeof m === 'string' && m.length > 0 && m.length <= 256;

/** Group raw points into 5-minute buckets: Map key "bucket\0metric" → { bucket, metric, sum, min, max, count }. */
function toBuckets(points) {
  const groups = new Map();
  for (const p of points) {
    const bucket = bucketOf(p.timestamp);
    const key = `${bucket}\u0000${p.metric}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { bucket, metric: p.metric, sum: 0, min: Infinity, max: -Infinity, count: 0 });
    g.sum += p.value; g.min = Math.min(g.min, p.value); g.max = Math.max(g.max, p.value); g.count++;
  }
  return groups;
}

/**
 * Store a batch of past readings.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} batch
 * @param {{metric: string, timestamp: number, value: number}[]} [batch.points] raw readings, timestamps in seconds.
 *   Those older than the raw retention are folded into 5-minute buckets first.
 * @param {{metric: string, bucket_start: number, avg: number, min: number, max: number, count: number}[]} [batch.buckets]
 *   readings the source has already put into 5-minute buckets (bucket_start in seconds, on a 5-minute boundary). A bucket
 *   inside the raw retention is stored as one raw reading of its mean, at the bucket's start.
 * @param {{now?: number}} [options] now in seconds (tests)
 * @returns {{raw: number, buckets: number, skipped: number, invalid: number, newest: Map<string, {timestamp: number, value: number}>}}
 */
function storeHistoricalBatch(db, { points = [], buckets = [] } = {}, { now = Math.floor(Date.now() / 1000) } = {}) {
  const cutoff = now - RETENTION_SECONDS;
  const result = { raw: 0, buckets: 0, skipped: 0, invalid: 0, newest: new Map() };

  const oldPoints = [], rawPoints = [];
  for (const p of points) {
    if (!p || !isName(p.metric) || !Number.isFinite(p.timestamp) || !Number.isFinite(p.value) || p.timestamp > now) { result.invalid++; continue; }
    const point = { metric: p.metric, timestamp: Math.floor(p.timestamp), value: p.value };
    (point.timestamp < cutoff ? oldPoints : rawPoints).push(point);
  }
  const groups = toBuckets(oldPoints);
  for (const b of buckets) {
    const ok = b && isName(b.metric) && Number.isInteger(b.bucket_start) && b.bucket_start % BUCKET_SECONDS === 0 && b.bucket_start <= now
      && Number.isFinite(b.avg) && Number.isFinite(b.min) && Number.isFinite(b.max) && Number.isInteger(b.count) && b.count > 0
      && b.min <= b.avg && b.avg <= b.max;
    if (!ok) { result.invalid++; continue; }
    if (b.bucket_start < cutoff) {
      const key = `${b.bucket_start}\u0000${b.metric}`;
      if (groups.has(key)) { result.skipped++; continue; }   // the batch named this bucket twice: keep the first
      groups.set(key, { bucket: b.bucket_start, metric: b.metric, sum: b.avg * b.count, min: b.min, max: b.max, count: b.count });
    } else {
      rawPoints.push({ metric: b.metric, timestamp: b.bucket_start, value: b.avg });
    }
  }

  const hasRaw = db.prepare('SELECT 1 FROM metrics WHERE metric = ? AND timestamp >= ? AND timestamp < ? LIMIT 1');
  const hasBucket = db.prepare('SELECT 1 FROM metrics_5m WHERE metric = ? AND bucket_start = ? LIMIT 1');
  const insertBucket = db.prepare(`INSERT INTO metrics_5m (bucket_start, metric, value_avg, value_min, value_max, value_count)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bucket_start, metric) DO NOTHING`);
  const insertRaw = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestIfMissing = db.prepare('INSERT OR IGNORE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');

  const noteNewest = (metric, timestamp, value) => {
    const seen = result.newest.get(metric);
    if (!seen || timestamp > seen.timestamp) result.newest.set(metric, { timestamp, value });
  };
  // The dashboard's own reading in this bucket wins; asked once per (metric, bucket) of the batch, before anything is written.
  const taken = new Map();
  const localHas = (metric, bucket) => {
    const key = `${bucket}\u0000${metric}`;
    if (!taken.has(key)) taken.set(key, !!(hasBucket.get(metric, bucket) || hasRaw.get(metric, bucket, bucket + BUCKET_SECONDS)));
    return taken.get(key);
  };

  db.transaction(() => {
    const groupList = [...groups.values()];
    const rawBlocked = rawPoints.map(p => localHas(p.metric, bucketOf(p.timestamp)));
    const groupBlocked = groupList.map(g => localHas(g.metric, g.bucket));
    groupList.forEach((g, i) => {
      if (groupBlocked[i]) { result.skipped++; return; }
      insertBucket.run(g.bucket, g.metric, g.sum / g.count, g.min, g.max, g.count);
      result.buckets++;
      noteNewest(g.metric, g.bucket, g.sum / g.count);
    });
    rawPoints.forEach((p, i) => {
      if (rawBlocked[i]) { result.skipped++; return; }
      if (insertRaw.run(p.timestamp, p.metric, p.value).changes) { result.raw++; noteNewest(p.metric, p.timestamp, p.value); }
      else result.skipped++;
    });
    // A metric the dashboard has never seen gets a latest value, so it is listed with the others.
    for (const [metric, { timestamp, value }] of result.newest) latestIfMissing.run(metric, value, timestamp);
  })();
  return result;
}

module.exports = { storeHistoricalBatch, toBuckets };
