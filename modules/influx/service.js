'use strict';
/**
 * The running InfluxDB link, one per process: the history import (importer.js), the writer of new readings (writer.js)
 * and the filling of gaps. start() and stop() never throw; they are called at startup, around a backup restore and at
 * shutdown.
 *
 * Filling gaps: once the history has been imported, the time since the last import or fill is read again from InfluxDB
 * a minute after startup and then once a day. Whatever another program (Home Assistant) wrote there while Epilykos was
 * off or could not reach its sources fills the hole; the dashboard's own readings still win, so where it has them
 * nothing changes. It keeps its own progress (influx_state.gap), so the import's status stays the user's.
 *
 * config influx_state: { connectedAt (s, when the connection was first saved), import, gap, write, syncedThrough (s) }
 *
 * @module influx/service
 */

const { logger } = require('../logger');
const { getConfig, setConfig, getDb } = require('../database');
const { createInfluxClient } = require('./client');
const settings = require('./settings');
const { createImporter } = require('./importer');
const { createWriter } = require('./writer');

const STATE_KEY = 'influx_state';

function loadState() { try { return JSON.parse(getConfig(STATE_KEY) || '{}') || {}; } catch (_) { return {}; } }
function saveState(state) { setConfig(STATE_KEY, JSON.stringify(state)); }

/** Remember when the connection was first saved: new readings are written from then on. */
function noteConnected(now = Math.floor(Date.now() / 1000)) {
  const state = loadState();
  if (!state.connectedAt) saveState({ ...state, connectedAt: now });
}

function importerDeps(stateKey) {
  return {
    stateKey,
    getClient: () => {
      const conn = settings.loadConnection();
      if (!settings.isConfigured(conn)) throw new Error('Save the InfluxDB connection first');
      return createInfluxClient(conn);
    },
    getDb,
    loadMapping: settings.loadMapping,
    loadState, saveState,
    roleMetrics: () => { try { return JSON.parse(getConfig('role_metrics') || '{}') || {}; } catch (_) { return {}; } },
    countPastDays: (db, fromDay) => require('../solarValue').countAddedPastDays(db, fromDay),
    clearCaches: db => require('../timeseriesReader').clearDailySnapshotCache(db),
    isCurrent: () => require('../databaseWork').isCurrent(),
    localDay: seconds => require('../localTime').localDateString(new Date(seconds * 1000)),
    log: logger,
  };
}

let importer = null;
function getImporter() {
  if (!importer) importer = createImporter(importerDeps('import'));
  return importer;
}

// ── Filling gaps ──
const GAP_FIRST_DELAY_MS = 60_000;
const GAP_EVERY_MS = 24 * 3600 * 1000;
const GAP_MIN_SECONDS = 15 * 60;       // less than this since the last fill: nothing to do
const GAP_OVERLAP_SECONDS = 3600;      // read the last hour before it again, in case it was still being written
let gapImporter = null;
let gapTimers = [];
function getGapImporter() {
  if (!gapImporter) gapImporter = createImporter(importerDeps('gap'));
  return gapImporter;
}

/** Read the time since the last import or fill. Resolves to the fill's result, or null when there was nothing to do. */
async function fillGaps(now = Math.floor(Date.now() / 1000)) {
  const gap = getGapImporter();
  if (getImporter().isRunning() || gap.isRunning()) return null;
  if (!settings.isConfigured() || !settings.loadMapping().length) return null;
  const state = loadState();
  const since = Math.max(state.syncedThrough || 0, (state.import && /^done/.test(state.import.state) && state.import.until) || 0);
  if (!since || now - since < GAP_MIN_SECONDS) return null;   // never imported: the user's import comes first
  const result = await gap.start(await gap.plan({ since: since - GAP_OVERLAP_SECONDS })).done;
  if (result && /^done/.test(result.state)) saveState({ ...loadState(), syncedThrough: result.until });
  const stored = Object.values((result && result.metrics) || {}).reduce((n, m) => n + m.buckets + m.raw, 0);
  if (stored) logger.info(`[influx] filled gaps since ${new Date(since * 1000).toISOString()}: ${stored} periods of 5 minutes`);
  return result;
}

function scheduleGaps() {
  const run = () => fillGaps().catch(e => logger.warn(`InfluxDB: could not fill gaps: ${e.message}`));
  const first = setTimeout(run, GAP_FIRST_DELAY_MS);
  const every = setInterval(run, GAP_EVERY_MS);
  for (const t of [first, every]) if (t.unref) t.unref();
  gapTimers = [first, every];
}

let writer = null;
function getWriter() {
  if (!writer) {
    writer = createWriter({
      getClient: () => {
        const conn = settings.loadConnection();
        return settings.isConfigured(conn) ? createInfluxClient(conn) : null;
      },
      getDb,
      loadWrite: settings.loadWrite,
      mappedMetrics: () => settings.loadMapping().map(r => r.metric),
      loadState, saveState,
      isCurrent: () => require('../databaseWork').isCurrent(),
      log: logger,
    });
  }
  return writer;
}

function start() {
  try { getWriter().start(); } catch (e) { logger.warn(`InfluxDB: the writer did not start: ${e.message}`); }
  try { getImporter().resume(); } catch (e) { logger.warn(`InfluxDB: could not carry on with the import: ${e.message}`); }
  try { if (!gapTimers.length) scheduleGaps(); } catch (e) { logger.warn(`InfluxDB: could not schedule the filling of gaps: ${e.message}`); }
}

async function stop() {
  try { if (writer) writer.stop(); } catch (e) { logger.warn(`InfluxDB: the writer did not stop: ${e.message}`); }
  for (const t of gapTimers) { clearTimeout(t); clearInterval(t); }
  gapTimers = [];
  try { if (importer) await importer.pause(); } catch (e) { logger.warn(`InfluxDB: could not pause: ${e.message}`); }
  try { if (gapImporter) await gapImporter.stop(); } catch (e) { logger.warn(`InfluxDB: could not stop filling gaps: ${e.message}`); }
}

module.exports = {
  STATE_KEY, loadState, saveState, noteConnected, getImporter, getGapImporter, getWriter, fillGaps, start, stop,
  setImporterForTests: i => { importer = i; }, setWriterForTests: w => { writer = w; }, setGapImporterForTests: i => { gapImporter = i; },
};
