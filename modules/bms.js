const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');
const { computeBankAggregates } = require('./bmsAggregator');

let bmsPollInterval = null;
let bmsPollingActive = false;
const BRIDGE_URL = process.env.BMS_BRIDGE_URL || 'http://bms-bridge:8020';

async function pollBMS() {
  if (bmsPollingActive) return;
  bmsPollingActive = true;
  const db = getDb();
  const devices = JSON.parse(getConfig('bms_devices') || '[]');
  if (!devices.length) { bmsPollingActive = false; return; }

  for (const device of devices) {
    if (!device.enabled || !device.address) continue;
    try {
      const res = await fetch(`${BRIDGE_URL}/device/${device.address}`, { timeout: 10000 });
      if (!res.ok) {
        logger.warn(`BMS ${device.name} returned ${res.status}`);
        continue;
      }
      const data = await res.json();
      const now = Math.floor(Date.now() / 1000);
      const mappings = device.mappings || {};
      const hasMappings = Object.keys(mappings).length > 0;
      for (const [key, val] of Object.entries(data)) {
        if (typeof val !== 'number' || isNaN(val)) continue;
        // Always store raw metric: bms_<device_name>_<key> (aggregator needs this)
        const safeName = `bms_${device.name}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');
        getBmsMetricInsert(db).run(now, safeName, val);
        getBmsLatestUpsert(db).run(safeName, val, now);
        // If device has metric mappings, also publish under the mapped name
        if (hasMappings && mappings[key]) {
          getBmsMetricInsert(db).run(now, mappings[key], val);
          getBmsLatestUpsert(db).run(mappings[key], val, now);
        }
      }
      logger.debug(`BMS ${device.name} polled successfully`);
    } catch (err) {
      logger.error(`BMS poll error for ${device.name}: ${err.message}`);
    }
  }

  // Compute bank aggregates after all devices polled
  try {
    const banks = JSON.parse(getConfig('bms_banks') || '[]');
    const pollInterval = parseInt(getConfig('bms_poll_interval')) || 30;
    for (const bank of banks) {
      await computeBankAggregates(bank, pollInterval);
    }
  } catch (err) {
    logger.error(`BMS bank aggregation error: ${err.message}`);
  }

  bmsPollingActive = false;
}

let bmsMetricInsert = null;
let bmsLatestUpsert = null;

function getBmsMetricInsert(db) {
  if (!bmsMetricInsert) bmsMetricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  return bmsMetricInsert;
}

function getBmsLatestUpsert(db) {
  if (!bmsLatestUpsert) bmsLatestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  return bmsLatestUpsert;
}

function startBmsPolling() {
  if (bmsPollInterval) clearInterval(bmsPollInterval);
  const intervalSec = parseInt(getConfig('bms_poll_interval')) || 30;
  logger.info(`BMS polling started: interval=${intervalSec}s, stale_threshold=${intervalSec * 2}s`);
  bmsPollInterval = setInterval(pollBMS, intervalSec * 1000);
  pollBMS(); // immediate first run
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
