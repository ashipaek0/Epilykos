/**
 * Bluetooth LE — in-container access to the host adapter.
 *
 * Replaces the bms-bridge sidecar. A single long-lived Python helper
 * (modules/ble/ble_helper.py, bleak + aiobmsble) talks to the host's BlueZ over
 * the mounted system D-Bus socket, so the main container needs no host
 * networking and no privileged mode.
 *
 * This module owns that child process: it starts it lazily on first use, sends
 * one request at a time (one adapter cannot scan and connect reliably in
 * parallel), kills and restarts it when a request times out, and fails fast
 * with a clear error when no D-Bus socket is mounted.
 *
 * @module ble
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { logger } = require('./logger');

const HELPER_SCRIPT = path.join(__dirname, 'ble', 'ble_helper.py');
const START_TIMEOUT_MS = 20000;
const RESTART_BACKOFF_MS = [1000, 5000, 15000, 60000];
// Exit the helper after this long without requests (a polled device keeps it
// alive), so installs that never use Bluetooth don't keep Python resident.
const IDLE_EXIT_MS = parseInt(process.env.BLE_IDLE_EXIT_MS, 10) || 5 * 60 * 1000;

class BleError extends Error {
  constructor(message, code = 'ble_error') {
    super(message);
    this.code = code;
  }
}

/** Path of the system D-Bus socket the helper will use. */
function dbusSocketPath() {
  const addr = process.env.DBUS_SYSTEM_BUS_ADDRESS;
  if (addr) {
    const m = /^unix:path=([^,;]+)/.exec(addr);
    return m ? m[1] : null; // abstract/tcp addresses: let the helper decide
  }
  return '/run/dbus/system_bus_socket';
}

/** False when Bluetooth is switched off or no D-Bus socket is mounted. */
function isConfigured() {
  if (/^(0|false|off|no)$/i.test(process.env.BLUETOOTH || '')) return false;
  const sock = dbusSocketPath();
  if (sock === null) return true;
  try { return fs.statSync(sock).isSocket(); } catch (_) { return false; }
}

class BleHelper {
  /**
   * @param {object} [opts]
   * @param {string} [opts.command] - executable (default: python3)
   * @param {string[]} [opts.args] - arguments (default: [-u, ble_helper.py])
   * @param {() => boolean} [opts.isConfigured] - availability gate
   */
  constructor(opts = {}) {
    this.command = opts.command || process.env.BLE_HELPER_PYTHON || 'python3';
    this.args = opts.args || ['-u', HELPER_SCRIPT];
    this.isConfigured = opts.isConfigured || isConfigured;
    this.idleExitMs = opts.idleExitMs || IDLE_EXIT_MS;
    this.idleTimer = null;
    this.child = null;
    this.ready = null;       // Promise resolved on the helper's ready line
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.failures = 0;
    this.notBefore = 0;
    this.stopped = false;
  }

  _start() {
    if (this.child) return this.ready;
    const now = Date.now();
    if (now < this.notBefore) {
      const wait = Math.ceil((this.notBefore - now) / 1000);
      return Promise.reject(new BleError(`Bluetooth helper restarting (retry in ${wait}s)`, 'restarting'));
    }
    this.stopped = false;
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BleError('Bluetooth helper did not start', 'start_failed'));
        this._kill('start timeout');
      }, START_TIMEOUT_MS);
      child.once('error', err => {
        clearTimeout(timer);
        reject(new BleError(`Cannot start Bluetooth helper: ${err.message}`, 'start_failed'));
      });
      child._onReady = () => { clearTimeout(timer); resolve(); };
      child._onEarlyExit = (msg) => { clearTimeout(timer); reject(new BleError(msg, 'start_failed')); };
    });
    this.ready.catch(() => {}); // surfaced through request()

    readline.createInterface({ input: child.stdout }).on('line', line => this._onLine(child, line));
    readline.createInterface({ input: child.stderr }).on('line', line => {
      if (/^(ERROR|CRITICAL|Traceback)/.test(line)) logger.warn(`[ble] ${line}`);
      else logger.debug(`[ble] ${line}`);
    });
    child.on('exit', (code, signal) => this._onExit(child, code, signal));
    child.on('error', err => {
      logger.warn(`[ble] helper process error: ${err.message}`);
      this._onExit(child, err.code || 'error', null); // spawn failures emit no 'exit'
    });
    return this.ready;
  }

  _onLine(child, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) {
      logger.debug(`[ble] non-JSON helper output: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.event === 'ready') {
      logger.info(`[ble] helper ready (pid ${msg.pid})`);
      if (child._onReady) child._onReady();
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) {
      this.failures = 0;
      entry.resolve(msg.result);
    } else {
      entry.reject(new BleError(msg.error || 'Bluetooth request failed', msg.code || 'ble_error'));
    }
  }

  _onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    const why = signal ? `signal ${signal}` : `code ${code}`;
    if (child._onEarlyExit) child._onEarlyExit(`Bluetooth helper exited during start (${why})`);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BleError(`Bluetooth helper exited (${why})`, 'helper_exit'));
      this.pending.delete(id);
    }
    if (!this.stopped) {
      const delay = RESTART_BACKOFF_MS[Math.min(this.failures, RESTART_BACKOFF_MS.length - 1)];
      this.failures++;
      this.notBefore = Date.now() + delay;
      logger.warn(`[ble] helper exited (${why}); next start in ${delay / 1000}s`);
    }
  }

  _kill(reason) {
    const child = this.child;
    if (!child) return;
    logger.warn(`[ble] stopping helper: ${reason}`);
    try { child.stdin.end(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
    if (typeof t.unref === 'function') t.unref();
  }

  /**
   * Send one command. Requests are serialised; timeoutMs covers only this
   * request's own execution, not time spent waiting behind earlier ones.
   */
  request(cmd, args = {}, timeoutMs = 30000) {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const run = () => this._send(cmd, args, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    const tail = this.queue;
    tail.then(() => {
      if (this.queue !== tail || !this.child) return; // more work queued
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.queue === tail && this.pending.size === 0 && this.child) {
          logger.debug('[ble] helper idle — stopping');
          this.stop().catch(() => {});
        }
      }, this.idleExitMs);
      if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
    });
    return p;
  }

  async _send(cmd, args, timeoutMs) {
    if (!this.isConfigured()) {
      throw new BleError('Bluetooth is not available: mount the host D-Bus socket (/run/dbus) into the container', 'no_dbus');
    }
    await this._start();
    const child = this.child;
    if (!child) throw new BleError('Bluetooth helper not running', 'helper_exit');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BleError(`Bluetooth ${cmd} timed out`, 'timeout'));
        // The helper may be stuck inside BlueZ; a fresh process is the only
        // reliable way to get a clean state for the next request.
        this._kill(`${cmd} timed out`);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BleError(`Bluetooth helper write failed: ${err.message}`, 'helper_exit'));
      }
    });
  }

  async stop() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.child) return;
    this.stopped = true;
    const child = this.child;
    // Detach first so a request arriving now starts a fresh helper instead of
    // writing to this one's closing stdin.
    this.child = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BleError('Bluetooth helper stopped', 'helper_exit'));
      this.pending.delete(id);
    }
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { child.stdin.end(); } catch (_) {} // helper disconnects devices on EOF
    const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, 3000);
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    clearTimeout(t);
  }
}

let shared = null;
function helper() {
  if (!shared) shared = new BleHelper();
  return shared;
}

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
function isValidAddress(address) {
  return typeof address === 'string' && MAC_RE.test(address.trim());
}

/** @returns {Promise<object>} { available, adapters, error?, code? } */
async function status() {
  if (!isConfigured()) {
    return { available: false, code: 'no_dbus', error: 'Bluetooth is not available: mount the host D-Bus socket (/run/dbus) into the container' };
  }
  try {
    return await helper().request('status', {}, 15000);
  } catch (err) {
    return { available: false, code: err.code || 'ble_error', error: err.message };
  }
}

/** @returns {Promise<Array<{address, name, rssi, bms_type}>>} */
function scan({ timeout = 8, all = false } = {}) {
  return helper().request('scan', { timeout, all }, (timeout + 20) * 1000);
}

/** The aiobmsble type each pack was last read as (e.g. 'jbd_bms'), by address. */
const bmsKinds = new Map();

/** @returns {Promise<Object<string, number>>} flattened BMS sample */
async function readBms(address, { timeout = 25, bmsType = '' } = {}) {
  const data = await helper().request('read_bms', { address, timeout, bms_type: bmsType || undefined }, (timeout + 5) * 1000);
  if (data && typeof data === 'object' && '__kind' in data) {
    if (typeof data.__kind === 'string' && data.__kind) bmsKinds.set(String(address).toUpperCase(), data.__kind);
    delete data.__kind;
  }
  return data;
}

/** aiobmsble type a pack was last read as, or ''. */
function bmsKind(address) { return bmsKinds.get(String(address || '').toUpperCase()) || ''; }

/**
 * Turn a JBD or JK pack's charging or discharging on/off. JBD needs the other
 * switch's current state (one command sets both).
 * @returns {Promise<{kind: 'jbd'|'jk'}>}
 */
function bmsSwitch(address, { bmsType = '', which, on, chargeOn, dischargeOn, timeout = 25 }) {
  return helper().request('bms_switch', { address, bms_type: bmsType || undefined, switch: which, on, charge_on: chargeOn, discharge_on: dischargeOn, timeout }, (timeout + 5) * 1000);
}

/**
 * Send one Modbus-RTU frame over a GATT write/notify pair.
 * @returns {Promise<Buffer>} complete response frame (CRC included)
 */
async function modbusExchange(address, { writeUuid, notifyUuid, frame, timeout = 15 }) {
  const result = await helper().request('modbus', {
    address, write_uuid: writeUuid, notify_uuid: notifyUuid, frame: frame.toString('hex'), timeout
  }, (timeout + 5) * 1000);
  return Buffer.from(result.frame, 'hex');
}

/**
 * Luxpower dongle exchange: write one A1 1A request frame, return the
 * notified response frame that answers it (same dev_fn, start register and
 * inverter serial). Unsolicited pushes arriving meanwhile are skipped.
 */
async function luxpowerExchange(address, { writeUuid, notifyUuid, frame, timeout = 15 }) {
  const result = await helper().request('luxpower', {
    address, write_uuid: writeUuid, notify_uuid: notifyUuid, frame: frame.toString('hex'), timeout
  }, (timeout + 5) * 1000);
  return Buffer.from(result.frame, 'hex');
}

/**
 * Read characteristics by (service, characteristic) — never writes.
 * @param {Array<{service: string, characteristic: string}>} reads
 * @returns {Promise<Array<Buffer|null>>} one entry per read (null = not on device)
 */
async function gattRead(address, reads, { timeout = 20 } = {}) {
  const result = await helper().request('gatt_read', { address, reads, timeout }, (timeout + 5) * 1000);
  return (result.values || []).map(v => (v === null || v === undefined ? null : Buffer.from(v, 'hex')));
}

function disconnect(address) {
  return helper().request('disconnect', { address }, 10000);
}

async function shutdownBle() {
  if (shared) await shared.stop();
}

module.exports = {
  BleHelper, BleError, isConfigured, isValidAddress,
  status, scan, readBms, bmsKind, bmsSwitch, modbusExchange, luxpowerExchange, gattRead, disconnect, shutdownBle,
  _setHelperForTests(h) { shared = h; }
};
