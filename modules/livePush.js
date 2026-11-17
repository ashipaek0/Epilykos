/**
 * Push the dashboard to open pages soon after new readings are stored, instead
 * of waiting for the next 30 s polling cycle.
 *
 * Sources that run on their own timers (Wi-Fi and Bluetooth dongles, batteries,
 * MQTT, REST) store readings every few seconds, but the pages only heard about
 * them once per cycle, so a 5 s dongle looked 30 s old. The database tells this
 * module when a batch of readings was stored (every 5 s at most); a page
 * update follows, at most once per `minMs`, and only while someone is
 * watching. A polling cycle that is running pushes by itself when it finishes,
 * so a request that arrives meanwhile is dropped.
 *
 * @module livePush
 */
'use strict';

/**
 * @param {object} deps
 * @param {number} [deps.minMs]      least time between two pushes
 * @param {number} [deps.settleMs]   wait after a request so one push covers a burst of readings
 * @param {() => number} [deps.now]
 * @param {() => boolean} deps.hasClients   any page connected?
 * @param {() => boolean} [deps.isCurrent]  the database is the live one
 * @param {() => boolean} [deps.busy]       a polling cycle is running
 * @param {() => Promise<object>} deps.build   the dashboard state
 * @param {(state: object) => void} deps.send  push it to the pages
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 * @param {{debug?: Function}} [deps.log]
 */
function createLivePush({ minMs = 5000, settleMs = 250, now = Date.now, hasClients, isCurrent = () => true, busy = () => false,
  build, send, setTimer = setTimeout, clearTimer = clearTimeout, log = {} }) {
  let timer = null, last = 0, running = false;

  async function fire() {
    timer = null;
    if (!hasClients() || !isCurrent() || busy()) return;
    running = true;
    try {
      const state = await build();
      if (hasClients() && isCurrent()) { send(state); last = now(); }
    } catch (err) {
      if (log.debug) log.debug(`Live push skipped: ${err && err.message}`);
    } finally { running = false; }
  }

  /** New readings were stored: schedule a push unless one is already due or running. */
  function request() {
    if (timer || running || !hasClients()) return;
    const wait = Math.max(settleMs, last + minMs - now());
    timer = setTimer(fire, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** The pages were just updated by other means (the polling cycle). */
  function notePush() { last = now(); }

  function stop() { if (timer) clearTimer(timer); timer = null; }

  return { request, notePush, stop };
}

module.exports = { createLivePush };
