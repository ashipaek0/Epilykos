const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');

let externalPollInterval = null;

function getValueByPath(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

async function pollExternalSources() {
  const sources = JSON.parse(getConfig('external_sources') || '[]');
  if (!sources.length) return;

  const db = getDb();
  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');

  for (const source of sources) {
    if (!source.enabled || !source.url) continue;
    try {
      const res = await fetch(source.url, { timeout: 10000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const now = Math.floor(Date.now() / 1000);
      for (const [jsonPath, metric] of Object.entries(source.mappings || {})) {
        let value = getValueByPath(data, jsonPath);
        if (value === undefined) continue;
        value = parseFloat(value);
        if (isNaN(value)) continue;
        metricInsert.run(now, metric, value);
        latestUpsert.run(metric, value, now);
      }
    } catch (err) {
      console.error(`External source ${source.name} error:`, err.message);
    }
  }
}

function startExternalPolling() {
  if (externalPollInterval) clearInterval(externalPollInterval);
  const intervalSec = parseInt(getConfig('external_poll_interval')) || 60;
  externalPollInterval = setInterval(pollExternalSources, intervalSec * 1000);
  pollExternalSources(); // immediate first run
}

function restartExternalPolling() {
  startExternalPolling();
}

module.exports = { startExternalPolling, restartExternalPolling, pollExternalSources };
