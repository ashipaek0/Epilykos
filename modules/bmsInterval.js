/**
 * How often each BMS is read.
 *
 * Every battery (Bluetooth or wired) has its own `poll_interval` in seconds; one without it
 * uses the `bms_poll_interval` setting, then 30. The pollers run a short tick and read the
 * batteries that are due, so a battery read every 10 s and another every 120 s share one
 * poller. A battery's readings count as fresh (for banks and the connection dot) for twice
 * its interval, and never less than a minute: a Bluetooth read can take 25 s, and several
 * batteries are read one after another over one adapter.
 *
 * @module bmsInterval
 */
const { getConfig } = require('./database');

const TICK_S = 5;          // how often the pollers look for batteries that are due
const MIN_S = 5;           // the shortest interval a battery can have
const MAX_S = 3600;
const DEFAULT_S = 30;
const MIN_STALE_S = 60;

const clamp = n => Math.min(MAX_S, Math.max(MIN_S, n));

/** The interval for batteries that don't set their own. */
function defaultInterval() {
  const n = parseInt(getConfig('bms_poll_interval'), 10);
  return n > 0 ? clamp(n) : DEFAULT_S;
}

/** Seconds between reads of one battery (a device config object). */
function deviceInterval(device) {
  const n = parseInt(device && device.poll_interval, 10);
  return n > 0 ? clamp(n) : defaultInterval();
}

/** Seconds a battery's newest reading stays fresh. */
function stalenessFor(device) {
  return Math.max(MIN_STALE_S, 2 * deviceInterval(device));
}

/** The configured BMS devices by name. */
function devicesByName() {
  const map = new Map();
  try {
    const list = JSON.parse(getConfig('bms_devices') || '[]');
    if (Array.isArray(list)) for (const d of list) if (d && d.name != null) map.set(String(d.name), d);
  } catch (_) { /* no devices */ }
  return map;
}

/** Freshness window for a battery known only by name; `fallbackS` when it isn't configured. */
function stalenessForName(name, fallbackS = 2 * DEFAULT_S) {
  const d = devicesByName().get(String(name));
  return d ? stalenessFor(d) : fallbackS;
}

/**
 * Remembers when each battery was last tried, so a tick reads only the ones that are due.
 * The attempt counts, not the success: a battery that fails waits its interval like any other
 * (and the poller's own backoff then spaces out repeated failures).
 */
function createDueTracker() {
  const last = new Map();
  return {
    isDue(device, nowMs = Date.now()) {
      const at = last.get(String(device.name));
      return at === undefined || nowMs - at >= deviceInterval(device) * 1000 - 500;   // half a second of slack for timer jitter
    },
    mark(device, nowMs = Date.now()) { last.set(String(device.name), nowMs); },
    reset() { last.clear(); },
  };
}

module.exports = { TICK_S, MIN_S, MAX_S, DEFAULT_S, MIN_STALE_S, defaultInterval, deviceInterval, stalenessFor, stalenessForName, devicesByName, createDueTracker };
