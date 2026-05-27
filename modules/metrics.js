const { logger } = require('./logger');
const { getDb } = require('./database');

function getCurrentMetrics() {
  const db = getDb();
  const rows = db.prepare('SELECT metric, value, timestamp, unit FROM latest_metrics').all();
  const result = {};
  rows.forEach(r => { result[r.metric] = { value: r.value, timestamp: r.timestamp * 1000, unit: r.unit || null }; });
  return result;
}

function getMetricHistory(metric, hours = 24) {
  const db = getDb();
  if (!metric) throw new Error('Metric name required');
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = db.prepare('SELECT timestamp, value FROM metrics WHERE metric = ? AND timestamp >= ? ORDER BY timestamp ASC').all(metric, since);
  return rows.map(r => ({ timestamp: r.timestamp * 1000, value: r.value }));
}

module.exports = { getCurrentMetrics, getMetricHistory };
