'use strict';
/**
 * The running InfluxDB link, one per process: the history import (importer.js). start() and stop() never throw; they are
 * called at startup, around a backup restore and at shutdown.
 *
 * config influx_state: { connectedAt (s, when the connection was first saved), import: { … } }
 *
 * @module influx/service
 */

const { logger } = require('../logger');
const { getConfig, setConfig, getDb } = require('../database');
const { createInfluxClient } = require('./client');
const settings = require('./settings');
const { createImporter } = require('./importer');

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

function start() {
  try { getImporter().resume(); } catch (e) { logger.warn(`InfluxDB: could not carry on with the import: ${e.message}`); }
}

async function stop() {
  try { if (importer) await importer.pause(); } catch (e) { logger.warn(`InfluxDB: could not pause: ${e.message}`); }
}

module.exports = { STATE_KEY, loadState, saveState, noteConnected, getImporter, start, stop, setImporterForTests: i => { importer = i; } };
