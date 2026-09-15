const { logger } = require('./logger');
const { getDb, flushMetrics } = require('./database');

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

function getMetricHistory(metric, hours = 24) {
  flushMetrics(); // read-your-write: drain the write queue before serving
  const db = getDb();
  if (!metric) throw new Error('Metric name required');
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = db.prepare('SELECT timestamp, value FROM metrics WHERE metric = ? AND timestamp >= ? ORDER BY timestamp ASC').all(metric, since);
  return rows.map(r => ({ timestamp: r.timestamp * 1000, value: r.value }));
}

module.exports = { getCurrentMetrics, getMetricHistory };
