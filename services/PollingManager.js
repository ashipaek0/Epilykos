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
 *
 * Sources that talk to devices carry a `lane`. Lanes run side by side, so a
 * Home Assistant that is slow to answer no longer holds up Modbus or Tuya;
 * sources in the same lane (the two that can use a serial port) still take
 * turns. Each of them also has SOURCE_DEADLINE_MS: past it the cycle goes on
 * without that source (its values from the last cycle stand), and the source
 * is left out of later cycles until the read it is stuck in has ended, so a
 * device is never polled twice at once. Sources without a lane work from the
 * database and run in order after the lanes, as before.
 */

const { EventEmitter } = require('node:events');
const databaseWork = require('../modules/databaseWork');
const { getBreaker } = require('../modules/circuitBreaker');
const { PollResult } = require('../modules/pollResult');

const POLL_INTERVAL_MS = 30000;
const SOURCE_DEADLINE_MS = 20000;

function defaultRegistry() {
  return [
    { id: 'ha', lane: 'ha', pollFn: () => require('../modules/ha').pollHomeAssistant() },
    { id: 'modbus', lane: 'serial', pollFn: () => require('../modules/modbus').pollModbus() },
    { id: 'tuya', lane: 'tuya', pollFn: () => require('../modules/tuya').pollTuyaDevices() },
    { id: 'rs232', lane: 'serial', pollFn: () => require('../modules/rs232').pollRs232() },
    // Virtual Battery, then combined metrics (sums, energy from power, ...),
    // before history, so a role mapped to either gets this cycle's value.
    { id: 'battery', pollFn: () => require('../modules/batteryEstimator').runBatteryEstimator() },
    // Today's savings is published here too, so it is current for the same cycle (it never fails the poll).
    { id: 'combined', pollFn: () => { const out = require('../modules/combinedMetrics').runCombinedMetrics(); require('../modules/savingsMetric').publishSavingsToday(); require('../modules/prepaidMeter').tick(); return out; } },
    { id: 'history', pollFn: () => require('../modules/history').pollLegacyHistory() },
    { id: 'grid', pollFn: () => require('../modules/grid').pollGridStatus() },
    { id: 'generator', pollFn: () => require('../modules/generator').pollGeneratorStatus() },
  ];
}

class PollingManager extends EventEmitter {
  constructor(sources) {
    super();
    this.sources = Array.isArray(sources) ? sources : defaultRegistry();
    this.intervalMs = POLL_INTERVAL_MS;
    this.deadlineMs = SOURCE_DEADLINE_MS;
    this._stuck = new Set();   // sources whose last read overran and has not ended
    this._timer = null;
  }

  /** One source, through its breaker. Resolves { ready } or { error }; never rejects. */
  async _pollOne({ id, pollFn, lane }) {
    if (this._stuck.has(id)) {
      return { error: new Error(`${id} is still busy with a read that did not finish in time`) };
    }
    try {
      const result = await getBreaker(id).execute(async () => {
        const work = Promise.resolve().then(pollFn);
        const outcome = lane ? await this._withDeadline(id, work) : await work;
        // Only stop the whole source family when every attempted read failed.
        // Partial failures must keep polling the devices that still respond.
        if (outcome instanceof PollResult && outcome.errors.length && outcome.errors.length === outcome.attempted) {
          throw outcome.error;
        }
        return outcome;
      });
      if (result instanceof PollResult) {
        if (!result.attempted) return {}; // disabled/unconfigured is not recovery
        if (result.errors.length) return { error: result.error };
      }
      return { ready: true };
    } catch (error) {
      return { error };
    }
  }

  /** `work`, or a timeout after the deadline. A read that overruns is remembered until it ends. */
  _withDeadline(id, work) {
    return new Promise((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        this._stuck.add(id);
        reject(new Error(`${id} did not answer within ${Math.round(this.deadlineMs / 1000)} s; the other sources carried on`));
      }, this.deadlineMs);
      if (typeof timer.unref === 'function') timer.unref();
      work.then(
        value => { clearTimeout(timer); if (late) this._stuck.delete(id); else resolve(value); },
        error => { clearTimeout(timer); if (late) this._stuck.delete(id); else reject(error); }
      );
    });
  }

  async runCycle() {
    if (!databaseWork.isCurrent()) return;
    // Lanes side by side; inside a lane, and for everything without one, in order.
    const lanes = new Map();
    for (const source of this.sources) {
      if (!source.lane) continue;
      if (!lanes.has(source.lane)) lanes.set(source.lane, []);
      lanes.get(source.lane).push(source);
    }
    const outcomes = new Map();
    await Promise.all([...lanes.values()].map(async (list) => {
      for (const source of list) {
        if (!databaseWork.isCurrent()) return;
        outcomes.set(source.id, await this._pollOne(source));
      }
    }));
    for (const source of this.sources) {
      if (!databaseWork.isCurrent()) return;
      const outcome = source.lane ? outcomes.get(source.id) : await this._pollOne(source);
      if (!databaseWork.isCurrent()) return;
      if (!outcome) continue;
      if (outcome.error) this.emit('device-error', { sourceId: source.id, error: outcome.error });
      else if (outcome.ready) this.emit('metrics-ready', { sourceId: source.id, data: null });
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

module.exports = { PollingManager, POLL_INTERVAL_MS, SOURCE_DEADLINE_MS, defaultRegistry };
