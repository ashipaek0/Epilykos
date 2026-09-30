const { getConfig, queueMetricValue } = require('./database');
const { logger } = require('./logger');
const { computeBankAggregates } = require('./bmsAggregator');
const ble = require('./ble');

let bmsPollInterval = null;
let bmsPollingActive = false;

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

async function pollBMS() {
  if (bmsPollingActive) {
    logger.warn('BMS poll skipped — previous cycle still running');
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
    if (!devices.length) return;

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
      return;
    }

    for (const device of devices) {
      try {
        const data = await readDevice(device.address, device.bms_type);
        storeSample(device, data, Math.floor(Date.now() / 1000));
        logger.debug(`BMS ${device.name} polled successfully`);
      } catch (err) {
        logger.warn(`BMS poll error for ${device.name}: ${err.message}`);
      }
    }

    // Compute bank aggregates after all devices polled
    try {
      let banks;
      try {
        banks = JSON.parse(getConfig('bms_banks') || '[]');
      } catch (e) {
        logger.error(`BMS: failed to parse bms_banks config: ${e.message}`);
        return;
      }
      const pollInterval = parseInt(getConfig('bms_poll_interval')) || 30;
      for (const bank of banks) {
        await computeBankAggregates(bank, pollInterval);
      }
    } catch (err) {
      logger.error(`BMS bank aggregation error: ${err.message}`);
    }
  } finally {
    bmsPollingActive = false;
  }
}

function startBmsPolling() {
  if (bmsPollInterval) clearInterval(bmsPollInterval);
  const intervalSec = parseInt(getConfig('bms_poll_interval')) || 30;
  const backend = legacyBridgeUrl() ? `legacy bridge ${legacyBridgeUrl()}` : 'built-in Bluetooth';
  logger.info(`BMS polling started: interval=${intervalSec}s, stale_threshold=${intervalSec * 2}s, backend=${backend}`);
  const run = () => pollBMS().catch(err => logger.error(`BMS poll failed: ${err.message}`));
  bmsPollInterval = setInterval(run, intervalSec * 1000);
  run(); // immediate first run
}

function restartBmsPolling() {
  startBmsPolling();
}

function stopBmsPolling() {
  if (bmsPollInterval) {
    clearInterval(bmsPollInterval);
    bmsPollInterval = null;
  }
  bmsPollingActive = false;
}

module.exports = {
  startBmsPolling, restartBmsPolling, pollBMS, stopBmsPolling,
  scanDevices, readDevice, storeSample, BmsBackendError
};
