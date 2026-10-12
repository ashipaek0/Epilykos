const { logger } = require('./logger');
const { getConfig, queueMetricValue } = require('./database');
const { assertSafeFetchUrl, safeFetch } = require('./utils');

let externalPollInterval = null;
let activePoll = null;
let pollGeneration = 0;

function getValueByPath(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

function pollExternalSources() {
  if (activePoll) return activePoll.promise;
  const poll = { controller: new AbortController(), promise: null };
  activePoll = poll;
  poll.promise = runExternalPoll(poll.controller.signal).finally(() => {
    if (activePoll === poll) activePoll = null;
  });
  return poll.promise;
}

async function runExternalPoll(signal) {
  const sources = JSON.parse(getConfig('external_sources') || '[]');
  if (!sources.length) return;

  for (const source of sources) {
    if (!source.enabled || !source.url) continue;
    try {
      // SSRF guard shared with the settings Test button: LAN and internet hosts
      // are allowed; loopback, link-local and cloud-metadata addresses are not.
      // Redirects are followed by hand and every hop re-checked (safeFetch).
      const safe = await assertSafeFetchUrl(source.url, { allowPrivate: true });
      signal.throwIfAborted();
      if (!safe.ok) {
        logger.warn(`External source "${source.name}": ${safe.error} (${source.url})`);
        continue;
      }
      const res = await safeFetch(source.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }, { allowPrivate: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      signal.throwIfAborted(); // a retired poll must not write into new settings/DB
      const now = Math.floor(Date.now() / 1000);
      // Mappings: { metricName → jsonPath } — iterate by metric name
      for (const [metric, jsonPath] of Object.entries(source.mappings || {})) {
        if (typeof jsonPath !== 'string' || !jsonPath) continue;
        queueMetricValue(metric, getValueByPath(data, jsonPath), now);
      }
    } catch (err) {
      if (signal.aborted) return;
      logger.error(`External source ${source.name} error: ${err.message}`);
    }
  }
}

function startExternalPolling() {
  stopExternalPolling();
  const generation = pollGeneration;
  const configuredInterval = parseInt(getConfig('external_poll_interval'));
  const intervalSec = configuredInterval > 0 ? configuredInterval : 60;
  const run = () => {
    if (generation !== pollGeneration || activePoll) return;
    pollExternalSources().catch(err => logger.error(`External sources poll failed: ${err.message}`));
  };
  externalPollInterval = setInterval(run, intervalSec * 1000);
  // A restart waits for the cancelled request to settle rather than overlapping it.
  if (activePoll) activePoll.promise.catch(() => {}).then(run);
  else run();
}

function restartExternalPolling() {
  startExternalPolling();
}

function stopExternalPolling() {
  pollGeneration++;
  if (activePoll) activePoll.controller.abort();
  if (externalPollInterval) {
    clearInterval(externalPollInterval);
    externalPollInterval = null;
  }
}

module.exports = { startExternalPolling, restartExternalPolling, pollExternalSources, stopExternalPolling };
