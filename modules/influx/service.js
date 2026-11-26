'use strict';
/**
 * The running InfluxDB link, one per process: the history import (importer.js) and the writer of new readings
 * (writer.js). start() and stop() never throw; they are called at startup, around a backup restore and at shutdown.
 *
 * config influx_state: { connectedAt (s, when the connection was first saved), import: { … }, write: { … } }
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

let importer = null;
function getImporter() {
  if (!importer) {
    importer = createImporter({
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
    });
  }
  return importer;
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
}

async function stop() {
  try { if (writer) writer.stop(); } catch (e) { logger.warn(`InfluxDB: the writer did not stop: ${e.message}`); }
  try { if (importer) await importer.pause(); } catch (e) { logger.warn(`InfluxDB: could not pause: ${e.message}`); }
}

module.exports = {
  STATE_KEY, loadState, saveState, noteConnected, getImporter, getWriter, start, stop,
  setImporterForTests: i => { importer = i; }, setWriterForTests: w => { writer = w; },
};
