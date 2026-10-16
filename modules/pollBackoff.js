/**
 * Poll a failing device less often.
 *
 * Several sources read their devices one after another over something shared:
 * one Bluetooth adapter, one serial port or RS485 bus. A device that is off,
 * unplugged or out of range spends its whole timeout on every cycle and holds
 * up the devices that work. After a few failures in a row it is skipped for
 * 1, 3, 7… cycles (up to MAX_SKIP), and polled every cycle again as soon as a
 * read succeeds. It is never dropped for good.
 *
 *   const backoff = createBackoff('[dongle]');
 *   if (backoff.skip(name)) continue;           // this cycle
 *   ... poll ...
 *   backoff.record(name, ok);
 */
const { logger } = require('./logger');

const AFTER = 3;      // failures in a row before skipping starts
const MAX_SKIP = 7;   // at most this many cycles skipped between attempts

function createBackoff(label, { after = AFTER, maxSkip = MAX_SKIP } = {}) {
  const state = new Map();   // key -> { failures, wait }

  return {
    /** True when this cycle should leave the device alone. */
    skip(key) {
      const s = state.get(key);
      if (!s || s.wait <= 0) return false;
      s.wait--;
      return true;
    },
    /** Record the outcome of an attempt. */
    record(key, ok) {
      const s = state.get(key) || { failures: 0, wait: 0 };
      if (ok) {
        if (s.failures >= after) logger.info(`${label} ${key}: answering again, back to every cycle`);
        state.delete(key);
        return;
      }
      s.failures++;
      if (s.failures >= after) {
        s.wait = Math.min(maxSkip, 2 ** (s.failures - after + 1) - 1);
        if (s.failures === after) logger.warn(`${label} ${key}: ${s.failures} failed polls in a row; trying it less often until it answers`);
      }
      state.set(key, s);
    },
    failures(key) { return (state.get(key) || {}).failures || 0; },
    reset() { state.clear(); },
  };
}

module.exports = { createBackoff, AFTER, MAX_SKIP };
