const { getDb, flushMetrics } = require('./database');
const { readMetricSeries } = require('./timeseriesReader');

// Open upper bound: these queries historically had no `timestamp <=` clause,
// so routing through readMetricSeries uses a sentinel far beyond any real
// epoch rather than "now" (avoids a timing race with in-flight writes).
const OPEN_END = Number.MAX_SAFE_INTEGER;

function getCurrentMetrics() {
  flushMetrics(); // read-your-write: drain the write queue before serving
  const db = getDb();
  const rows = db.prepare('SELECT metric, value, value_text, value_type, timestamp, unit FROM latest_metrics').all();
  const result = {};
  rows.forEach(r => { 
    result[r.metric] = { 
      value: r.value_text != null ? r.value_text : r.value, 
      type: r.value_type || 'number',
      timestamp: r.timestamp * 1000, 
      unit: r.unit || null 
    }; 
  });
  return result;
}

/**
 * Thin a series to at most `maxPoints` by averaging it into equal time buckets (each point is stamped with its
 * bucket's start, like the stored 5-minute roll-ups). A series already within the limit is returned as it is.
 * Pure. The last bucket holds the newest reading, so a card showing "now" still shows the latest values.
 * @param {{timestamp: number, value: number}[]} points oldest first, timestamps in milliseconds
 * @param {number} maxPoints
 * @param {number} spanMs the time the series is meant to cover (sets the bucket size)
 */
function thinSeries(points, maxPoints, spanMs) {
  if (!Array.isArray(points) || !(maxPoints >= 1) || points.length <= maxPoints) return points;
  const bucketMs = Math.max(1000, Math.ceil(spanMs / maxPoints / 1000) * 1000);
  const out = [];
  let key = null, sum = 0, count = 0;
  const flush = () => { if (count) out.push({ timestamp: key * bucketMs, value: sum / count }); };
  for (const p of points) {
    const k = Math.floor(p.timestamp / bucketMs);
    if (k !== key) { flush(); key = k; sum = 0; count = 0; }
    if (Number.isFinite(p.value)) { sum += p.value; count++; }
  }
  flush();
  return out;
}

/**
 * A metric's readings over the last `hours`, as [{ timestamp (ms), value }].
 * @param {{maxPoints?: number}} [options] maxPoints thins a longer series (see thinSeries); the dashboard's
 *   public cards ask for at most a week, and a week at the stored 5-minute resolution is 2,016 points
 */
function getMetricHistory(metric, hours = 24, { maxPoints } = {}) {
  flushMetrics(); // read-your-write: drain the write queue before serving
  const db = getDb();
  if (!metric) throw new Error('Metric name required');
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = readMetricSeries(db, { metric, from: since, to: OPEN_END, toInclusive: true });
  const points = rows.map(r => ({ timestamp: r.timestamp * 1000, value: r.value }));
  return maxPoints ? thinSeries(points, maxPoints, hours * 3600 * 1000) : points;
}

module.exports = { getCurrentMetrics, getMetricHistory, thinSeries };
