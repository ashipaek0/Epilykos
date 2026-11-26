'use strict';
/**
 * Write new readings to the user's InfluxDB (Settings → InfluxDB → Writing new readings).
 *
 * It reads them back from the dashboard's own `metrics` table, in time order from a saved position, rather than keeping a
 * queue in memory: an InfluxDB that is down for a day, or a restart of Epilykos, loses nothing; the writer carries on from
 * where it was once it can (as far back as the raw readings are kept, 30 days). Readings from before the connection was
 * first saved (connectedAt) are never written: they are in InfluxDB already, or came from it.
 *
 * Each reading becomes one point: measurement (default "epilykos"), tag metric=<name>, field value (a float), second
 * precision. Numbers only. Every reading, or only the mapped metrics (influx_write.all).
 *
 * The newest LAG_SECONDS are left for the next round, so readings still in the write buffer, or stamped a little late by
 * a device clock, are not skipped.
 * A batch InfluxDB refuses as malformed (HTTP 400) is passed over, so one bad point never stops the rest; anything else
 * (no network, a refused token, a busy server) is tried again later, waiting longer each time, up to five minutes.
 *
 * @module influx/writer
 */

const { formatPoint } = require('./lineProtocol');

const INTERVAL_MS = 10_000;
const BATCH = 5000;
const LAG_SECONDS = 120;   // a reading stamped up to two minutes late (a device clock, the write buffer) is still written
const MAX_BACKOFF_MS = 5 * 60_000;
const SAVE_EVERY_MS = 60_000;

/**
 * @param {object} deps
 * @param {() => object|null} deps.getClient       a client for the saved connection, or null when there is none
 * @param {() => import('better-sqlite3').Database} deps.getDb
 * @param {() => {measurement: string, all: boolean}} deps.loadWrite
 * @param {() => string[]} deps.mappedMetrics
 * @param {() => object} deps.loadState            config influx_state ({ connectedAt, write: { t, metric, written, lastWriteAt } })
 * @param {(state: object) => void} deps.saveState
 * @param {() => boolean} [deps.isCurrent]       false once a restore replaced the database
 * @param {() => number} [deps.now]                seconds
 * @param {() => number} [deps.nowMs]
 * @param {object} [deps.log]
 */
function createWriter(deps) {
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs || (() => Date.now());
  const log = deps.log || { info() {}, warn() {} };
  const isCurrent = deps.isCurrent || (() => true);
  let timer = null;
  let busy = false;
  let failures = 0;
  let nextAt = 0;
  let lastSavedAt = 0;
  const status = { state: 'off', lastError: null };

  const writeState = () => { const s = deps.loadState() || {}; return { connectedAt: s.connectedAt || null, ...(s.write || {}) }; };
  function saveWrite(w) {
    if (!isCurrent()) return;   // a restore replaced the database while this round ran: its position is its own
    const s = deps.loadState() || {};
    deps.saveState({ ...s, write: { t: w.t, metric: w.metric, written: w.written, lastWriteAt: w.lastWriteAt } });
  }

  /** One round: send what is new, as many batches as are ready. Resolves to the number of points written. */
  async function round() {
    if (busy) return 0;
    const client = deps.getClient();
    if (!client) { status.state = 'off'; return 0; }
    let w = writeState();
    if (!w.connectedAt) {
      // Connected without the first save recorded (saved by an earlier version): write from now on.
      if (!isCurrent()) return 0;
      deps.saveState({ ...(deps.loadState() || {}), connectedAt: now() });
      w = writeState();
    }
    if (nowMs() < nextAt) return 0;
    busy = true;
    let sent = 0, refused = null;
    try {
      const settings = deps.loadWrite();
      const only = settings.all ? null : new Set(deps.mappedMetrics());
      if (only && !only.size) { status.state = 'idle'; return 0; }
      // Start from the saved position, or from the connection's first save.
      let t = Number.isInteger(w.t) ? w.t : w.connectedAt - 1, metric = typeof w.metric === 'string' ? w.metric : '￿';
      const until = now() - LAG_SECONDS;
      const db = deps.getDb();
      const page = db.prepare(`SELECT timestamp, metric, value FROM metrics
        WHERE (timestamp, metric) > (?, ?) AND timestamp <= ?
        ORDER BY timestamp, metric LIMIT ${BATCH}`);
      for (;;) {
        const rows = page.all(t, metric, until);
        if (!rows.length) break;
        const lines = [];
        for (const r of rows) {
          if (r.value === null || (only && !only.has(r.metric))) continue;
          const line = formatPoint({ measurement: settings.measurement, tags: { metric: r.metric }, field: 'value', value: r.value, timestamp: r.timestamp });
          if (line) lines.push(line);
        }
        const last = rows[rows.length - 1];
        try {
          await client.write(lines);
        } catch (e) {
          if (e.status === 400) {
            log.warn(`[influx] InfluxDB refused ${lines.length} points as malformed, passing over them: ${e.message}`);
            refused = e.message;
          } else throw e;
        }
        t = last.timestamp; metric = last.metric;
        w.t = t; w.metric = metric; w.written = (w.written || 0) + lines.length; w.lastWriteAt = now();
        sent += lines.length;
        if (rows.length < BATCH) break;
        await new Promise(r => setImmediate(r));   // a long catch-up never holds the event loop
      }
      if (sent || nowMs() - lastSavedAt > SAVE_EVERY_MS) { saveWrite(w); lastSavedAt = nowMs(); }
      if (failures) log.info('[influx] writing to InfluxDB again');
      failures = 0; nextAt = 0;
      status.state = 'ok'; status.lastError = refused;
      return sent;
    } catch (e) {
      failures++;
      const wait = Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** (failures - 1));
      nextAt = nowMs() + wait;
      if (failures === 1 || failures % 10 === 0) log.warn(`[influx] could not write to InfluxDB (${e.message}); trying again in ${Math.round(wait / 1000)} s`);
      status.state = 'error'; status.lastError = e.message;
      if (sent) { saveWrite(w); lastSavedAt = nowMs(); }   // the batches before the failure are written
      return sent;
    } finally {
      busy = false;
    }
  }

  return {
    round,
    start() {
      if (timer) return;
      timer = setInterval(() => { round().catch(() => {}); }, INTERVAL_MS);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() {
      const w = writeState();
      return { state: status.state, lastError: status.lastError, written: w.written || 0, lastWriteAt: w.lastWriteAt || null, through: Number.isInteger(w.t) ? w.t : null, connectedAt: w.connectedAt };
    },
    /** Write from now on, forgetting the saved position (after the measurement changes, for one). */
    restartFrom(seconds) { const s = deps.loadState() || {}; deps.saveState({ ...s, write: { t: seconds - 1, metric: '￿', written: (s.write || {}).written || 0, lastWriteAt: (s.write || {}).lastWriteAt || null } }); },
  };
}

module.exports = { createWriter, INTERVAL_MS, BATCH, LAG_SECONDS };
