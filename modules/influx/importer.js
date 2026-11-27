'use strict';
/**
 * Import the history of the mapped metrics from the user's InfluxDB (Settings → InfluxDB → Import history).
 *
 * For each mapped metric, from its first reading in InfluxDB up to the moment the import starts, in windows of a week:
 * the server works out 5-minute buckets (mean, min, max, count), Epilykos scales them and stores them with
 * storeHistoricalBatch (the dashboard's own readings always win). Then the role history (solar, load, battery, grid) is
 * filled for the imported time, finished days are counted in the savings, and the cached daily totals are dropped.
 *
 * Progress is saved after every window in config influx_state, so an import that a restart interrupts carries on where it
 * was. A metric that cannot be read (its series was removed, the token lost access) is marked and skipped; the others go on.
 * A network failure is tried again, with growing pauses, before the metric is given up.
 *
 * @module influx/importer
 */

const { storeHistoricalBatch } = require('../historicalStore');
const { buildRoleHistory } = require('./roleHistory');
const { BUCKET_SECONDS } = require('../timeseriesReader');

const WINDOW_SECONDS = 7 * 86400;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const BYTES_PER_BUCKET = 110;     // a metrics_5m row with its index entry, measured on a real database
const bucketOf = t => Math.floor(t / BUCKET_SECONDS) * BUCKET_SECONDS;
const RETRYABLE = new Set(['network', 'timeout', 'rate']);

/** Mean, min and max multiplied by `scale` (a negative scale swaps min and max). */
function scaleBucket(b, scale) {
  if (scale === 1) return b;
  const lo = b.min * scale, hi = b.max * scale;
  return { ...b, avg: b.avg * scale, min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getClient             an InfluxDB client for the saved connection (modules/influx/client.js)
 * @param {() => import('better-sqlite3').Database} deps.getDb
 * @param {() => object[]} deps.loadMapping
 * @param {() => object} deps.loadState            config influx_state
 * @param {(state: object) => void} deps.saveState
 * @param {() => object} deps.roleMetrics           config role_metrics
 * @param {(db, fromDay: string) => number} [deps.countPastDays] savings for the imported days
 * @param {(db) => void} [deps.clearCaches]
 * @param {() => boolean} [deps.isCurrent]          false once a restore replaced the database: the import stops
 * @param {() => number} [deps.now]                 seconds
 * @param {(ms: number) => Promise} [deps.sleep]
 * @param {(day: number) => string} [deps.localDay] seconds → YYYY-MM-DD in local time
 * @param {object} [deps.log]
 * @param {string} [deps.stateKey]                 where in influx_state its progress is kept ('import', or 'gap' for the
 *                                                  filling of gaps, so that never replaces the user's import's status)
 */
function createImporter(deps) {
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const log = deps.log || { info() {}, warn() {} };
  const isCurrent = deps.isCurrent || (() => true);
  let running = null;      // the promise of the import in progress
  let stopMode = null;     // 'stop' (the user stopped it) or 'pause' (a restore or shutdown: it carries on later)

  const key = deps.stateKey || 'import';
  const importState = () => (deps.loadState() || {})[key] || null;
  function saveImport(imp) { deps.saveState({ ...(deps.loadState() || {}), [key]: imp }); }

  /**
   * What an import would do: per metric, its first reading and how many 5-minute buckets that is at most.
   * With `since` (seconds), every metric from then on instead, without asking for first readings (filling a gap).
   */
  async function plan({ since } = {}) {
    const client = deps.getClient();
    const until = bucketOf(now());
    const metrics = [];
    for (const row of deps.loadMapping()) {
      const series = { measurement: row.measurement, field: row.field, tags: row.tags };
      if (Number.isFinite(since)) {
        const from = Math.min(bucketOf(since), until);
        metrics.push({ metric: row.metric, from, buckets: Math.ceil((until - from) / BUCKET_SECONDS) });
        continue;
      }
      try {
        const first = await client.first(series);
        const from = first === null ? null : bucketOf(first);
        const buckets = from === null ? 0 : Math.max(0, Math.ceil((until - from) / BUCKET_SECONDS));
        metrics.push({ metric: row.metric, from, buckets });
      } catch (e) {
        metrics.push({ metric: row.metric, from: null, buckets: 0, error: e.message });
      }
    }
    const buckets = metrics.reduce((n, m) => n + m.buckets, 0);
    return { until, metrics, buckets, bytes: buckets * BYTES_PER_BUCKET };
  }

  async function windowWithRetries(client, series, from, to) {
    for (let attempt = 0; ; attempt++) {
      try { return await client.buckets(series, from, to); }
      catch (e) {
        const retryable = RETRYABLE.has(e.kind) || e.status >= 500;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length || stopMode) throw e;
        log.warn(`[influx] import: ${e.message}; trying again in ${RETRY_DELAYS_MS[attempt] / 1000} s`);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  async function runImport(imp) {
    const client = deps.getClient();
    const mapping = new Map(deps.loadMapping().map(r => [r.metric, r]));
    for (const name of Object.keys(imp.metrics)) {
      const m = imp.metrics[name];
      const row = mapping.get(name);
      if (m.done) continue;
      if (!row) { m.done = true; m.error = 'No longer mapped'; continue; }
      const series = { measurement: row.measurement, field: row.field, tags: row.tags };
      while (m.cursor < imp.until) {
        if (!isCurrent()) return imp;                       // a restore replaced the database: its state is its own
        if (stopMode === 'pause') return imp;               // still 'running' in the state: resume() carries on
        if (stopMode === 'stop') { imp.state = 'stopped'; saveImport(imp); return imp; }
        const end = Math.min(m.cursor + WINDOW_SECONDS, imp.until);
        let buckets;
        try { buckets = await windowWithRetries(client, series, m.cursor, end); }
        catch (e) {
          if (stopMode) { if (stopMode === 'stop') { imp.state = 'stopped'; saveImport(imp); } return imp; }
          m.error = e.message; m.done = true; log.warn(`[influx] import of ${name} stopped: ${e.message}`); break;
        }
        if (!isCurrent()) return imp;   // a restore replaced the database while we waited
        const db = deps.getDb();
        const r = storeHistoricalBatch(db, { buckets: buckets.map(b => ({ ...scaleBucket(b, row.scale), metric: name })) }, { now: now() });
        m.buckets += r.buckets; m.raw += r.raw; m.skipped += r.skipped;
        m.cursor = end;
        saveImport(imp);
      }
      if (m.cursor >= imp.until) m.done = true;
      saveImport(imp);
    }

    // Everything read: the role history, the savings and the cached daily totals.
    const db = deps.getDb();
    const imported = Object.entries(imp.metrics).filter(([, m]) => m.buckets + m.raw > 0);
    if (imported.length) {
      const from = Math.min(...imported.map(([, m]) => m.from));
      const h = buildRoleHistory(db, { from, to: imp.until, roleMetrics: deps.roleMetrics(), onlyMetrics: imported.map(([n]) => n), now: now() });
      imp.history = h;
      if (deps.countPastDays && deps.localDay) imp.savingsDays = deps.countPastDays(db, deps.localDay(from));
      if (deps.clearCaches) deps.clearCaches(db);
    }
    imp.state = Object.values(imp.metrics).some(m => m.error) ? 'done-with-errors' : 'done';
    imp.finishedAt = now();
    saveImport(imp);
    const totals = Object.values(imp.metrics).reduce((t, m) => ({ b: t.b + m.buckets + m.raw, s: t.s + m.skipped }), { b: 0, s: 0 });
    if (key !== 'gap') log.info(`[influx] import finished: ${totals.b} buckets stored, ${totals.s} already there`);
    return imp;
  }

  function launch(imp) {
    stopMode = null;
    running = runImport(imp)
      .catch(e => { imp.state = 'error'; imp.error = e.message; imp.finishedAt = now(); try { saveImport(imp); } catch (_) { /* the database is gone */ } log.warn(`[influx] import failed: ${e.message}`); return imp; })
      .finally(() => { running = null; });
    return running;
  }

  return {
    plan,

    /** Start an import from a plan (the result of plan()). Resolves when it has started; `done` resolves when it ends. */
    start(p) {
      if (running) throw new Error('An import is already running');
      const metrics = {};
      for (const m of p.metrics) {
        if (m.from === null) continue;
        metrics[m.metric] = { from: m.from, cursor: m.from, done: false, buckets: 0, raw: 0, skipped: 0, error: null };
      }
      if (!Object.keys(metrics).length) throw new Error('None of the mapped metrics has readings in InfluxDB');
      const imp = { state: 'running', startedAt: now(), until: p.until, metrics };
      saveImport(imp);
      return { started: true, done: launch(imp) };
    },

    /** Carry on with an import a restart interrupted. */
    resume() {
      const imp = importState();
      if (running || !imp || imp.state !== 'running') return null;
      log.info('[influx] carrying on with the history import');
      return launch(imp);
    },

    /** Stop after the window in progress. Resolves when it has stopped. */
    async stop() {
      stopMode = 'stop';
      if (running) await running;
      const imp = importState();
      if (imp && imp.state === 'running') { imp.state = 'stopped'; saveImport(imp); }
    },

    /** Stop without marking the import stopped, so the next start carries on (a restore or a shutdown). */
    async pause() { stopMode = 'pause'; const r = running; if (r) await r.catch(() => {}); },

    status() {
      const imp = importState();
      if (!imp) return { state: 'idle' };
      const metrics = Object.entries(imp.metrics || {}).map(([metric, m]) => ({
        metric, done: m.done, error: m.error, buckets: m.buckets + m.raw, skipped: m.skipped,
        progress: imp.until > m.from ? Math.min(1, (m.cursor - m.from) / (imp.until - m.from)) : 1,
      }));
      const progress = metrics.length ? metrics.reduce((a, m) => a + m.progress, 0) / metrics.length : 0;
      return { state: running ? 'running' : imp.state, startedAt: imp.startedAt, finishedAt: imp.finishedAt || null, until: imp.until, progress, metrics, error: imp.error || null };
    },

    isRunning: () => !!running,
  };
}

module.exports = { createImporter, scaleBucket, WINDOW_SECONDS, BYTES_PER_BUCKET };
