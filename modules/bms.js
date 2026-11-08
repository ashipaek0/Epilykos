const { getConfig, queueMetricValue } = require('./database');
const { logger } = require('./logger');
const { createBackoff } = require('./pollBackoff');
const backoff = createBackoff('BMS');
const { computeBankAggregates } = require('./bmsAggregator');
const ble = require('./ble');
const databaseWork = require('./databaseWork');
const { TICK_S, deviceInterval, createDueTracker, devicesByName } = require('./bmsInterval');

let bmsPollInterval = null;
let bmsPollingActive = false;
const due = createDueTracker();      // when each battery was last tried
const bankLast = new Map();          // when each bank was last computed

// Bluetooth BMS runs inside this container (modules/ble.js). Setting
// BMS_BRIDGE_URL keeps using a separately deployed legacy bms-bridge sidecar
// instead — deprecated, kept so existing installs keep working on upgrade.
function legacyBridgeUrl() {
  const url = (process.env.BMS_BRIDGE_URL || '').trim();
  return url ? url.replace(/\/+$/, '') : null;
}

class BmsBackendError extends Error {
  constructor(message, status = 502, code = 'ble_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Map a BLE helper error code to an HTTP status for the settings routes. */
function statusForCode(code) {
  switch (code) {
    case 'bad_request': return 400;
    case 'not_found': return 404;
    case 'unsupported': return 422;
    case 'no_dbus': case 'no_adapter': case 'adapter_off': case 'no_bluez':
    case 'dbus_denied': case 'restarting': case 'start_failed': return 503;
    case 'timeout': return 504;
    default: return 502;
  }
}

async function legacyFetchJson(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new BmsBackendError('BMS bridge not reachable. Check that the bms-bridge container is running, or unset BMS_BRIDGE_URL to use built-in Bluetooth.', 502, 'bridge_unreachable');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(`BMS bridge returned ${res.status}: ${text.slice(0, 200)}`);
    throw new BmsBackendError(`Bridge returned ${res.status}`, 502, 'bridge_error');
  }
  return res.json();
}

/**
 * Discover nearby Bluetooth BMS devices.
 * @param {boolean} force - legacy bridge only: bypass its 60s scan cache
 * @returns {Promise<Array<{address, name, rssi, bms_type?}>>}
 */
async function scanDevices(force = false) {
  const bridge = legacyBridgeUrl();
  if (bridge) {
    return legacyFetchJson(force ? `${bridge}/devices?force_scan=true` : `${bridge}/devices`, 20000);
  }
  try {
    return await ble.scan({ timeout: 8 });
  } catch (err) {
    throw new BmsBackendError(err.message, statusForCode(err.code), err.code);
  }
}

/**
 * Read one sample from a Bluetooth BMS.
 * @returns {Promise<Object<string, number>>}
 */
// aiobmsble plugin names a user may force when auto-detection fails.
const BMS_TYPE_RE = /^[a-z0-9]+(_[a-z0-9]+)*_bms$/;

async function readDevice(address, bmsType = '') {
  const bridge = legacyBridgeUrl();
  if (bridge) {
    return legacyFetchJson(`${bridge}/device/${encodeURIComponent(address)}`, 10000);
  }
  if (!ble.isValidAddress(address)) throw new BmsBackendError('Invalid Bluetooth address', 400, 'bad_request');
  try {
    const type = BMS_TYPE_RE.test(String(bmsType || '')) ? bmsType : '';
    return await ble.readBms(address.trim().toUpperCase(), { bmsType: type });
  } catch (err) {
    throw new BmsBackendError(err.message, statusForCode(err.code), err.code);
  }
}

/** Queue one device's sample under bms_<name>_<key> plus any mapped names. */
function storeSample(device, data, now) {
  const mappings = device.mappings || {};
  const hasMappings = Object.keys(mappings).length > 0;
  for (const [key, val] of Object.entries(data)) {
    if (val === null || val === undefined) continue;
    if (typeof val === 'object' && !Array.isArray(val)) continue;
    // Always store raw metric: bms_<device_name>_<key> (aggregator needs this)
    const safeName = `bms_${device.name}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');
    queueMetricValue(safeName, val, now);
    // If device has metric mappings, also publish under the mapped name
    if (hasMappings && mappings[key]) {
      queueMetricValue(mappings[key], val, now);
    }
  }
}

/**
 * Compute the battery banks from the readings of their batteries. Bluetooth and wired
 * batteries both store bms_<name>_<key>, so a bank does not care which kind it has, and this
 * runs whether or not any Bluetooth battery is set up or Bluetooth is available.
 *
 * With dueOnly (the poller's tick) a bank is computed when its own interval has passed: the
 * shortest read interval of its batteries.
 */
async function computeBanks({ dueOnly = false } = {}) {
  try {
    let banks;
    try {
      banks = JSON.parse(getConfig('bms_banks') || '[]');
    } catch (e) {
      logger.error(`BMS: failed to parse bms_banks config: ${e.message}`);
      return;
    }
    if (!Array.isArray(banks) || !banks.length) return;
    const byName = devicesByName();
    const defaultPoll = parseInt(getConfig('bms_poll_interval')) || 30;
    const nowMs = Date.now();
    for (const bank of banks) {
      const intervals = (bank.devices || []).map(d => deviceInterval(byName.get(String(d.name)) || {}));
      const every = intervals.length ? Math.min(...intervals) : defaultPoll;
      if (dueOnly) {
        const at = bankLast.get(bank.name);
        if (at !== undefined && nowMs - at < every * 1000 - 500) continue;
      }
      bankLast.set(bank.name, nowMs);
      await computeBankAggregates(bank, defaultPoll);
    }
  } catch (err) {
    logger.error(`BMS bank aggregation error: ${err.message}`);
  }
}

/**
 * One look at the batteries. From the poller's tick (dueOnly) only the batteries whose own
 * interval has passed are read; called directly, every battery is read.
 */
async function pollBMS({ dueOnly = false } = {}) {
  if (bmsPollingActive) {
    (dueOnly ? logger.debug : logger.warn)('BMS poll skipped — previous cycle still running');
    return;
  }
  bmsPollingActive = true;
  try {
    let devices;
    try {
      devices = JSON.parse(getConfig('bms_devices') || '[]');
    } catch (e) {
      logger.error(`BMS: failed to parse bms_devices config: ${e.message}`);
      return;
    }
    devices = devices.filter(d => d && d.enabled && d.address);
    const nowMs = Date.now();
    const todo = dueOnly ? devices.filter(d => due.isDue(d, nowMs)) : devices;
    // Nothing due (or no Bluetooth battery at all, as with wired batteries only): banks still need computing.
    if (!todo.length) { await computeBanks({ dueOnly }); return; }

    const bridge = legacyBridgeUrl();
    if (bridge) {
      // The legacy bridge only serves /device/<MAC> for devices in its scan cache.
      try {
        await fetch(`${bridge}/devices?force_scan=true`, { signal: AbortSignal.timeout(15000) });
      } catch (err) {
        logger.warn(`BMS pre-scan failed: ${err.message} — devices may return 404`);
      }
    } else if (!ble.isConfigured()) {
      logger.warn('BMS: Bluetooth devices configured but no D-Bus socket is mounted — mount /run/dbus into the container');
      await computeBanks({ dueOnly });   // a bank that also has wired batteries still has data
      return;
    }

    for (const device of todo) {
      if (!databaseWork.isCurrent()) return;
      due.mark(device);   // the attempt counts, so a failing battery waits its interval too
      // Packs are read one after another over one adapter: a pack that is off
      // or out of range is tried less often so it doesn't hold up the others.
      if (backoff.skip(device.name)) continue;
      try {
        const data = await readDevice(device.address, device.bms_type);
        if (!databaseWork.isCurrent()) return;
        storeSample(device, data, Math.floor(Date.now() / 1000));
        backoff.record(device.name, true);
        logger.debug(`BMS ${device.name} polled successfully`);
      } catch (err) {
        if (!databaseWork.isCurrent()) return;
        backoff.record(device.name, false);
        logger.warn(`BMS poll error for ${device.name}: ${err.message}`);
      }
    }

    // Compute bank aggregates after the devices are read
    await computeBanks({ dueOnly });
  } finally {
    bmsPollingActive = false;
  }
}

function startBmsPolling() {
  if (bmsPollInterval) clearInterval(bmsPollInterval);
  backoff.reset();   // saving settings retries every pack straight away
  due.reset(); bankLast.clear();
  const backend = legacyBridgeUrl() ? `legacy bridge ${legacyBridgeUrl()}` : 'built-in Bluetooth';
  logger.info(`BMS polling started: each battery on its own interval (default ${parseInt(getConfig('bms_poll_interval')) || 30}s), backend=${backend}`);
  const run = () => pollBMS({ dueOnly: true }).catch(err => logger.error(`BMS poll failed: ${err.message}`));
  bmsPollInterval = setInterval(run, TICK_S * 1000);
  run(); // immediate first run: every battery is due
}

function restartBmsPolling() {
  startBmsPolling();
}

function stopBmsPolling() {
  if (bmsPollInterval) {
    clearInterval(bmsPollInterval);
    bmsPollInterval = null;
  }
  // An in-flight read retains exclusion until its own finally completes.
}

module.exports = {
  startBmsPolling, restartBmsPolling, pollBMS, stopBmsPolling,
  scanDevices, readDevice, storeSample, computeBanks, BmsBackendError
};
