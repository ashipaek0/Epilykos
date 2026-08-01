const { logger } = require('./logger');
const fetch = require('node-fetch');
const dns = require('dns').promises;
const { getConfig, getDb } = require('./database');
const { isPrivateOrLocalIp, isValidHostname } = require('./utils');

let externalPollInterval = null;
let externalMetricInsert = null;
let externalLatestUpsert = null;

function getValueByPath(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

async function pollExternalSources() {
  const sources = JSON.parse(getConfig('external_sources') || '[]');
  if (!sources.length) return;

  const db = getDb();
  if (!externalMetricInsert) externalMetricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  if (!externalLatestUpsert) externalLatestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');

  for (const source of sources) {
    if (!source.enabled || !source.url) continue;
    try {
      // SSRF protection: validate and resolve URL hostname before fetch
      let parsedUrl;
      try { parsedUrl = new URL(source.url); } catch { continue; }
      const host = parsedUrl.hostname;
      // Block literal private/local IPs
      const ipVersion = require('net').isIP(host);
      if (ipVersion) {
        if (isPrivateOrLocalIp(host.toLowerCase())) {
          logger.warn(`External source "${source.name}": blocked URL pointing to private/local IP (${host})`);
          continue;
        }
      } else {
        if (!isValidHostname(host) || host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.local')) {
          logger.warn(`External source "${source.name}": blocked URL with disallowed hostname (${host})`);
          continue;
        }
        // Resolve hostname and check for private IP
        try {
          const addresses = await dns.resolve4(host);
          if (addresses.some(addr => isPrivateOrLocalIp(addr))) {
            logger.warn(`External source "${source.name}": blocked URL resolving to private IP (${host})`);
            continue;
          }
        } catch (dnsErr) {
          logger.warn(`External source "${source.name}": DNS resolution failed for ${host}: ${dnsErr.message}`);
          continue;
        }
      }
      const res = await fetch(source.url, { timeout: 10000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const now = Math.floor(Date.now() / 1000);
      // Mappings: { metricName → jsonPath } — iterate by metric name
      for (const [metric, jsonPath] of Object.entries(source.mappings || {})) {
        let value = getValueByPath(data, jsonPath);
        if (value === undefined) continue;
        value = parseFloat(value);
        if (isNaN(value)) continue;
        externalMetricInsert.run(now, metric, value);
        externalLatestUpsert.run(metric, value, now);
      }
    } catch (err) {
      logger.error(`External source ${source.name} error:`, err.message);
    }
  }
}

function startExternalPolling() {
  if (externalPollInterval) clearInterval(externalPollInterval);
  const intervalSec = parseInt(getConfig('external_poll_interval')) || 60;
  externalPollInterval = setInterval(pollExternalSources, intervalSec * 1000);
  pollExternalSources().catch(err => logger.error('External sources initial poll failed:', err.message)); // immediate first run
}

function restartExternalPolling() {
  startExternalPolling();
}

function stopExternalPolling() {
  if (externalPollInterval) {
    clearInterval(externalPollInterval);
    externalPollInterval = null;
  }
}

module.exports = { startExternalPolling, restartExternalPolling, pollExternalSources, stopExternalPolling };
