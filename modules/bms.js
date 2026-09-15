const { getConfig, queueMetricWrite } = require('./database');
const { logger } = require('./logger');
const { computeBankAggregates } = require('./bmsAggregator');

let bmsPollInterval = null;
let bmsPollingActive = false;
const BRIDGE_URL = process.env.BMS_BRIDGE_URL || 'http://bms-bridge:8020';

async function pollBMS() {
  if (bmsPollingActive) {
    logger.warn('BMS poll skipped — previous cycle still running');
    return;
  }
  bmsPollingActive = true;
  try {
    const db = getDb();
    let devices;
    try {
      devices = JSON.parse(getConfig('bms_devices') || '[]');
    } catch (e) {
      logger.error(`BMS: failed to parse bms_devices config: ${e.message}`);
      return;
    }
    if (!devices.length) return;

    // Trigger a scan to populate the bridge's BLE cache
    // The bridge only serves /device/<MAC> for devices in its scan cache.
    try {
      await fetch(`${BRIDGE_URL}/devices?force_scan=true`, { signal: AbortSignal.timeout(15000) });
    } catch (err) {
      logger.warn(`BMS pre-scan failed: ${err.message} — devices may return 404`);
    }

    for (const device of devices) {
      if (!device.enabled || !device.address) continue;
      try {
        const res = await fetch(`${BRIDGE_URL}/device/${device.address}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          logger.warn(`BMS ${device.name} returned ${res.status}`);
          continue;
        }
        const data = await res.json();
        const now = Math.floor(Date.now() / 1000);
        const mappings = device.mappings || {};
        const hasMappings = Object.keys(mappings).length > 0;
        for (const [key, val] of Object.entries(data)) {
          if (val === null || val === undefined) continue;
          if (typeof val === 'object' && !Array.isArray(val)) continue;
          // Always store raw metric: bms_<device_name>_<key> (aggregator needs this)
          const safeName = `bms_${device.name}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');
          saveBmsMetric(db, safeName, val, now);
          // If device has metric mappings, also publish under the mapped name
          if (hasMappings && mappings[key]) {
            saveBmsMetric(db, mappings[key], val, now);
          }
        }
        logger.debug(`BMS ${device.name} polled successfully`);
      } catch (err) {
        logger.error(`BMS poll error for ${device.name}: ${err.message}`);
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

function saveBmsMetric(metricName, rawValue, timestamp) {
  if (rawValue === null || rawValue === undefined) return;
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return;
  const num = parseFloat(rawValue);
  if (!isNaN(num) && num === Number(rawValue)) {
    queueMetricWrite({ metric: metricName, value: num, timestamp });
  } else {
    const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
    const lower = strVal.toLowerCase();
    const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
    const type = isBool ? 'boolean' : 'string';
    const displayVal = isBool ? lower : strVal;
    queueMetricWrite({ metric: metricName, value: null, value_text: displayVal, value_type: type, timestamp });
  }
}

function startBmsPolling() {
  if (bmsPollInterval) clearInterval(bmsPollInterval);
  const intervalSec = parseInt(getConfig('bms_poll_interval')) || 30;
  logger.info(`BMS polling started: interval=${intervalSec}s, stale_threshold=${intervalSec * 2}s`);
  bmsPollInterval = setInterval(pollBMS, intervalSec * 1000);
  pollBMS().catch(err => logger.error('BMS initial poll failed:', err.message)); // immediate first run
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

module.exports = { startBmsPolling, restartBmsPolling, pollBMS, stopBmsPolling };
