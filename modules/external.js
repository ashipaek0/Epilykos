const { logger } = require('./logger');
const dns = require('dns').promises;
const { getConfig, queueMetricValue } = require('./database');
const { isPrivateOrLocalIp, isValidHostname } = require('./utils');

let externalPollInterval = null;

function getValueByPath(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

async function pollExternalSources() {
  const sources = JSON.parse(getConfig('external_sources') || '[]');
  if (!sources.length) return;

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
      const res = await fetch(source.url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const now = Math.floor(Date.now() / 1000);
      // Mappings: { metricName → jsonPath } — iterate by metric name
      for (const [metric, jsonPath] of Object.entries(source.mappings || {})) {
        if (typeof jsonPath !== 'string' || !jsonPath) continue;
        queueMetricValue(metric, getValueByPath(data, jsonPath), now);
      }
    } catch (err) {
      logger.error(`External source ${source.name} error: ${err.message}`);
    }
  }
}

function startExternalPolling() {
  if (externalPollInterval) clearInterval(externalPollInterval);
  const intervalSec = parseInt(getConfig('external_poll_interval')) || 60;
  const run = () => pollExternalSources().catch(err => logger.error(`External sources poll failed: ${err.message}`));
  externalPollInterval = setInterval(run, intervalSec * 1000);
  run(); // immediate first run
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
