const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');

let bmsPollInterval = null;
const BRIDGE_URL = process.env.BMS_BRIDGE_URL || 'http://bms-bridge:8000';

async function pollBMS() {
  const db = getDb();
  const devices = JSON.parse(getConfig('bms_devices') || '[]');
  if (!devices.length) return;

  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');

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
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'number' && !isNaN(val)) {
          // Create a clean metric name: bms_<device_name>_<key>
          const safeName = `bms_${device.name}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');
          metricInsert.run(now, safeName, val);
          latestUpsert.run(safeName, val, now);
        }
      }
      logger.debug(`BMS ${device.name} polled successfully`);
    } catch (err) {
      logger.error(`BMS poll error for ${device.name}: ${err.message}`);
    }
  }
}

function startBmsPolling() {
  if (bmsPollInterval) clearInterval(bmsPollInterval);
  const intervalSec = 30; // could be made configurable
  bmsPollInterval = setInterval(pollBMS, intervalSec * 1000);
  pollBMS(); // immediate first run
}

function restartBmsPolling() {
  startBmsPolling();
}

module.exports = { startBmsPolling, restartBmsPolling, pollBMS };
