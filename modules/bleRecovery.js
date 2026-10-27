/**
 * Notice a stuck BlueZ and ask EpilykosOS to restart it.
 *
 * On the Pi 3B a reply lost on the Bluetooth UART can leave bluetoothd
 * waiting on an operation that never finishes: from then on every connect
 * and scan is refused with org.bluez.Error.InProgress, for every device,
 * until bluetoothd restarts. A lost reply while the adapter starts leaves
 * no adapter at all ("no_adapter"). Restarting the app doesn't help (BlueZ
 * runs on the host); restarting bluetoothd does.
 *
 * Every device request's outcome is recorded here (modules/ble.js). When
 * every device tried in the last RECENT_MS has been refused that way, the
 * first of them at least STUCK_MS ago, and nothing has worked since, the
 * host is asked for `bluetooth_recover` (epilykos-hostd), at most once per
 * COOLDOWN_MS. Other errors (timeouts, a device out of range) neither count
 * nor clear it: only a request that works does.
 *
 * @module bleRecovery
 */
'use strict';

const STUCK_MS = 2 * 60 * 1000;
const RECENT_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
// Helper commands that talk to a device or scan; status and settings don't count.
const DEVICE_COMMANDS = new Set(['scan', 'read_bms', 'modbus', 'luxpower', 'gatt_read', 'phocos_gatt_change', 'bms_switch']);

/** 'in_progress' | 'no_adapter' for an error that means BlueZ is stuck, else null. */
function stuckReason(err) {
  if (!err) return null;
  if (err.code === 'no_adapter') return 'no_adapter';
  if (/org\.bluez\.Error\.InProgress/.test(String(err.message || ''))) return 'in_progress';
  return null;
}

/**
 * @param {object} deps
 * @param {() => number} [deps.now]
 * @param {() => boolean} deps.available       EpilykosOS host actions reachable
 * @param {(action: string, params: object) => Promise<object>} deps.call
 * @param {{info: Function, warn: Function}} deps.log
 */
function createMonitor({ now = Date.now, available, call, log }) {
  const lastTry = new Map();   // device key -> ms of its last request
  const stuck = new Map();     // device key -> { reason, since }
  let lastOk = 0;
  let nextAllowed = 0;
  let asking = false;

  function due(t) {
    if (asking || t < nextAllowed || !stuck.size) return null;
    const recent = [...lastTry].filter(([, at]) => t - at <= RECENT_MS).map(([k]) => k);
    if (!recent.length || !recent.every(k => stuck.has(k))) return null;
    const since = Math.min(...recent.map(k => stuck.get(k).since));
    if (t - since < STUCK_MS || t - lastOk < STUCK_MS) return null;
    return recent.some(k => stuck.get(k).reason === 'no_adapter') ? 'no_adapter' : 'in_progress';
  }

  async function ask(reason, t) {
    asking = true;
    nextAllowed = t + COOLDOWN_MS;
    try {
      const reply = await call('bluetooth_recover', { reason });
      if (reply && reply.ok && reply.restarted) {
        log.warn(`[ble] Bluetooth is stuck (${reason === 'no_adapter' ? 'no adapter' : 'every device refused: operation already in progress'}); asked EpilykosOS to restart BlueZ`);
        stuck.clear();
      } else if (reply && reply.ok) {
        nextAllowed = t + Math.max(60, Number(reply.retry_in) || 0) * 1000;
        log.info(`[ble] Bluetooth is stuck; BlueZ was restarted recently, next try in ${Math.round((nextAllowed - t) / 1000)} s`);
      } else {
        log.warn(`[ble] Bluetooth is stuck; restarting BlueZ was refused: ${(reply && reply.error) || 'no reply'}`);
      }
    } catch (err) {
      log.warn(`[ble] Bluetooth is stuck; could not ask EpilykosOS to restart BlueZ: ${err.message}`);
    } finally {
      asking = false;
    }
  }

  /** Record one helper request's outcome; may ask for a restart. */
  function record(cmd, args, err) {
    if (!DEVICE_COMMANDS.has(cmd)) return null;
    const t = now();
    const key = args && args.address ? String(args.address).toUpperCase() : cmd;
    lastTry.set(key, t);
    if (!err) { stuck.delete(key); lastOk = t; return null; }
    const reason = stuckReason(err);
    if (reason && !stuck.has(key)) stuck.set(key, { reason, since: t });
    const r = due(t);
    if (!r) return null;
    if (!available()) { nextAllowed = t + COOLDOWN_MS; log.warn('[ble] Bluetooth is stuck; restart BlueZ on the host (systemctl restart bluetooth)'); return null; }
    return ask(r, t);
  }

  return { record, due, _state: () => ({ stuck: new Map(stuck), lastOk, nextAllowed }) };
}

let shared = null;
/** The app's monitor, using EpilykosOS host actions. */
function monitor() {
  if (!shared) {
    const hostActions = require('./hostActions');
    const { logger } = require('./logger');
    shared = createMonitor({ available: () => hostActions.available(), call: (a, p) => hostActions.call(a, p), log: logger });
  }
  return shared;
}

module.exports = { createMonitor, monitor, stuckReason, STUCK_MS, RECENT_MS, COOLDOWN_MS, DEVICE_COMMANDS };
