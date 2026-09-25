const { logger } = require('./logger');
const { getConfig, queueMetricValue } = require('./database');
const { assertSafeFetchUrl } = require('./utils');

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
      // SSRF guard shared with the settings Test button: LAN and internet hosts
      // are allowed; loopback, link-local and cloud-metadata addresses are not.
      const safe = await assertSafeFetchUrl(source.url, { allowPrivate: true });
      if (!safe.ok) {
        logger.warn(`External source "${source.name}": ${safe.error} (${source.url})`);
        continue;
      }
      const res = await fetch(safe.url, { signal: AbortSignal.timeout(10000) });
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
