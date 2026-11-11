const { logger } = require('./logger');
const { getConfig, queueMetricValue } = require('./database');
const { assertSafeFetchUrl, safeFetch } = require('./utils');

let externalPollInterval = null;
let activePoll = null;
let pollGeneration = 0;

// A source that fails (a rate limit, a device that is off) is not asked again every poll, and is
// not logged every poll: the retries slow down, and the log says so once an hour. Open-Meteo, for
// one, answers HTTP 429 until its daily limit resets; asking every 30 s through the night only
// kept it limited and filled the log with the same line.
const sourceState = new Map();   // source -> { fails, nextAt, lastLog }
const MAX_BACKOFF_MS = 15 * 60 * 1000;          // any failure: 1, 2, 4 ... polls, up to this
const RATE_LIMIT_FIRST_MS = 15 * 60 * 1000;     // HTTP 429 without Retry-After: this, doubling,
const RATE_LIMIT_MAX_MS = 2 * 60 * 60 * 1000;   // up to this
const RETRY_AFTER_MAX_MS = 6 * 60 * 60 * 1000;  // a Retry-After is believed up to this
const REMIND_MS = 60 * 60 * 1000;
const sourceKey = source => `${source.name}\n${source.url}`;

function pollIntervalMs() {
  const configured = parseInt(getConfig('external_poll_interval'));
  return (configured > 0 ? configured : 60) * 1000;
}

/** How long to leave a source alone after its `fails`-th failure in a row. */
function retryDelayMs(err, fails, intervalMs) {
  if (err && err.status === 429) {
    const header = Number(err.retryAfter);
    if (Number.isFinite(header) && header > 0) return Math.min(RETRY_AFTER_MAX_MS, Math.max(60 * 1000, header * 1000));
    return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_FIRST_MS * 2 ** (fails - 1));
  }
  return Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** (fails - 1));
}

const duration = ms => (ms >= 3600000 ? `${Math.round(ms / 360000) / 10} h` : ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);

function noteFailure(source, err) {
  const key = sourceKey(source), now = Date.now(), intervalMs = pollIntervalMs();
  const st = sourceState.get(key) || { fails: 0, nextAt: 0, lastLog: 0 };
  st.fails++;
  const delay = retryDelayMs(err, st.fails, intervalMs);
  st.nextAt = now + delay;
  const first = st.fails === 1;
  const text = `External source ${source.name} error: ${err.message}` + (first ? '' : ` (${st.fails} polls failed in a row)`)
    + (delay > intervalMs ? `; trying again in ${duration(delay)}` : '');
  if (first || now - st.lastLog >= REMIND_MS) { st.lastLog = now; logger.error(text); }
  else logger.debug(text);
  sourceState.set(key, st);
}

function noteSuccess(source) {
  const key = sourceKey(source), st = sourceState.get(key);
  if (st && st.fails) logger.info(`External source ${source.name} is answering again after ${st.fails} failed poll${st.fails === 1 ? '' : 's'}`);
  sourceState.delete(key);
}

/** The error for a non-2xx answer, with the service's own reason when it gives one. */
async function httpError(res) {
  let reason = '';
  try {
    const body = typeof res.text === 'function' ? String(await res.text()).slice(0, 2000) : '';
    try { const j = JSON.parse(body); reason = typeof j.reason === 'string' ? j.reason : (typeof j.error === 'string' ? j.error : ''); } catch (_) { /* not JSON */ }
  } catch (_) { /* no body */ }
  const err = new Error(`HTTP ${res.status}${reason ? `: ${reason.slice(0, 200)}` : ''}`);
  err.status = res.status;
  const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (retryAfter != null) err.retryAfter = Number(retryAfter);
  return err;
}

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
    const resting = sourceState.get(sourceKey(source));
    if (resting && Date.now() < resting.nextAt) continue;   // failed lately: not asked again yet
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
      if (!res.ok) throw await httpError(res);
      const data = await res.json();
      signal.throwIfAborted(); // a retired poll must not write into new settings/DB
      const now = Math.floor(Date.now() / 1000);
      // Mappings: { metricName → jsonPath } — iterate by metric name
      for (const [metric, jsonPath] of Object.entries(source.mappings || {})) {
        if (typeof jsonPath !== 'string' || !jsonPath) continue;
        queueMetricValue(metric, getValueByPath(data, jsonPath), now);
      }
      noteSuccess(source);
    } catch (err) {
      if (signal.aborted) return;
      noteFailure(source, err);
    }
  }
}

function startExternalPolling() {
  stopExternalPolling();
  sourceState.clear();   // saving the settings tries every source again at once
  const generation = pollGeneration;
  const intervalSec = pollIntervalMs() / 1000;
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

module.exports = { startExternalPolling, restartExternalPolling, pollExternalSources, stopExternalPolling, retryDelayMs };
