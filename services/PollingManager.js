'use strict';

/**
 * services/PollingManager.js — Phase 3 Step 1 (standalone slice).
 *
 * Owns the 30s polling cadence (matches the current pollAllSources loop in
 * server.js). Sequential per-source cycle: getBreaker(id).execute(pollFn).
 * Success → emit('metrics-ready', { sourceId, data: null }) — data stays in
 * the DB via queueMetricWrite; the event is a signal. Failure → emit
 * ('device-error', { sourceId, error }). One source failing never stops the
 * others. No tiers (10s/30s/5m parked until agreed). No server.js wiring here.
 */

const { EventEmitter } = require('node:events');
const databaseWork = require('../modules/databaseWork');
const { getBreaker } = require('../modules/circuitBreaker');
const { PollResult } = require('../modules/pollResult');

const POLL_INTERVAL_MS = 30000;

function defaultRegistry() {
  return [
    { id: 'ha', pollFn: () => require('../modules/ha').pollHomeAssistant() },
    { id: 'modbus', pollFn: () => require('../modules/modbus').pollModbus() },
    { id: 'tuya', pollFn: () => require('../modules/tuya').pollTuyaDevices() },
    { id: 'rs232', pollFn: () => require('../modules/rs232').pollRs232() },
    // Combined metrics (sums, energy from power, ...) before history, so a role
    // mapped to a combined metric gets this cycle's value.
    { id: 'combined', pollFn: () => require('../modules/combinedMetrics').runCombinedMetrics() },
    { id: 'history', pollFn: () => require('../modules/history').pollLegacyHistory() },
    { id: 'grid', pollFn: () => require('../modules/grid').pollGridStatus() },
  ];
}

class PollingManager extends EventEmitter {
  constructor(sources) {
    super();
    this.sources = Array.isArray(sources) ? sources : defaultRegistry();
    this.intervalMs = POLL_INTERVAL_MS;
    this._timer = null;
  }

  async runCycle() {
    for (const { id, pollFn } of this.sources) {
      if (!databaseWork.isCurrent()) return;
      try {
        const result = await getBreaker(id).execute(async () => {
          const outcome = await pollFn();
          // Only stop the whole source family when every attempted read failed.
          // Partial failures must keep polling the devices that still respond.
          if (outcome instanceof PollResult && outcome.errors.length && outcome.errors.length === outcome.attempted) {
            throw outcome.error;
          }
          return outcome;
        });
        if (!databaseWork.isCurrent()) return;
        if (result instanceof PollResult) {
          if (!result.attempted) continue; // disabled/unconfigured is not recovery
          if (result.errors.length) {
            this.emit('device-error', { sourceId: id, error: result.error });
            continue;
          }
        }
        this.emit('metrics-ready', { sourceId: id, data: null });
      } catch (error) {
        if (!databaseWork.isCurrent()) return;
        this.emit('device-error', { sourceId: id, error });
      }
    }
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.runCycle().catch(() => {});
    }, this.intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.removeAllListeners();
    return this;
  }

  get running() {
    return this._timer !== null;
  }
}

module.exports = { PollingManager, POLL_INTERVAL_MS, defaultRegistry };
