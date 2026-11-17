/**
 * What to send to the open dashboards for one new state: the whole state, only
 * what changed, or nothing.
 *
 *   nothing changed      nothing, except a whole state every third quiet
 *                        polling cycle so no page drifts (never for a live
 *                        push between cycles)
 *   a small change       the change
 *   most of it changed   the whole state (smaller than describing the change)
 *
 * A message over `maxBytes` is not sent. That used to leave the pages without
 * live updates for good once the whole state had outgrown the limit: the
 * oversized state was refused, so the next change was measured against an
 * ever older state and was refused too. Now the change is sent instead when
 * the whole state is too large, and the limit is 1 MB (the first state a page
 * gets when it connects never had one).
 *
 * @module broadcastPlan
 */
'use strict';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const bytes = text => Buffer.byteLength(text, 'utf8');

/**
 * @param {object} o
 * @param {object} o.state         the new state
 * @param {object} o.delta         computeDelta(state, last sent state)
 * @param {number} o.quietCycles   polling cycles in a row with nothing sent
 * @param {boolean} [o.live]       a push between polling cycles
 * @param {number} [o.maxBytes]
 * @returns {{ message: string|null, quietCycles: number, tooLarge: number }}
 *   message to send (null: nothing), the new quiet-cycle count, and the size
 *   of a message that was dropped for being too large (0: none).
 */
function planBroadcast({ state, delta, quietCycles, live = false, maxBytes = MAX_MESSAGE_BYTES }) {
  const full = () => JSON.stringify({ type: 'dashboard-state', data: state });
  const empty = delta && typeof delta === 'object' && !Array.isArray(delta) && Object.keys(delta).length === 0;

  if (empty) {
    if (live) return { message: null, quietCycles, tooLarge: 0 };
    if (quietCycles < 2) return { message: null, quietCycles: quietCycles + 1, tooLarge: 0 };
    const message = full();
    // Nothing changed, so skipping an oversized refresh loses nothing.
    return bytes(message) > maxBytes ? { message: null, quietCycles: 0, tooLarge: 0 } : { message, quietCycles: 0, tooLarge: 0 };
  }

  const whole = full();
  const change = JSON.stringify({ type: 'dashboard-delta', data: delta });
  let preferWhole;
  try { preferWhole = bytes(JSON.stringify(delta)) > 0.8 * bytes(JSON.stringify(state)); } catch (_) { preferWhole = true; }
  const order = preferWhole ? [whole, change] : [change, whole];
  for (const message of order) {
    if (bytes(message) <= maxBytes) return { message, quietCycles: 0, tooLarge: 0 };
  }
  return { message: null, quietCycles: 0, tooLarge: Math.min(bytes(whole), bytes(change)) };
}

module.exports = { planBroadcast, MAX_MESSAGE_BYTES };
