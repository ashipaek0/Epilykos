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
const { getBreaker } = require('../modules/circuitBreaker');

const POLL_INTERVAL_MS = 30000;

function defaultRegistry() {
  return [
    { id: 'ha', pollFn: () => require('../modules/ha').pollHomeAssistant() },
    { id: 'modbus', pollFn: () => require('../modules/modbus').pollModbus() },
    { id: 'tuya', pollFn: () => require('../modules/tuya').pollTuyaDevices() },
    { id: 'rs232', pollFn: () => require('../modules/rs232').pollRs232() },
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
      try {
        await getBreaker(id).execute(() => pollFn());
        this.emit('metrics-ready', { sourceId: id, data: null });
      } catch (error) {
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
