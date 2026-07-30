const { logger } = require('./logger');
const { getConfig, getDb } = require('./database');
const { execFile } = require('child_process');
const path = require('path');

// Module-level cached prepared statements (same pattern as ha.js / mqtt.js / modbus.js)
let metricInsertStmt = null;
let latestUpsertStmt = null;

function getMetricInsert() {
  if (!metricInsertStmt) {
    const db = getDb();
    metricInsertStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  }
  return metricInsertStmt;
}

function getLatestUpsert() {
  if (!latestUpsertStmt) {
    const db = getDb();
    latestUpsertStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  }
  return latestUpsertStmt;
}

/**
 * Spawn a Python bridge script and return its parsed JSON output.
 * @param {string} script - absolute path to the Python script
 * @param {string[]} args  - positional arguments for the script
 * @returns {Promise<any>}  - parsed JSON (object or array)
 */
function runBridge(script, args) {
  return new Promise((resolve, reject) => {
    execFile('python3', [script, ...args], { timeout: 25000 }, (err, stdout, stderr) => {
      if (err) {
        // Many bridge scripts print structured JSON errors on stdout/stderr.
        const raw = (stdout || stderr || '').trim();
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error));
        } catch (_) { /* not JSON — fall through to generic message */ }
        return reject(new Error(err.message || 'Bridge process failed'));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (parseErr) {
        reject(new Error(`Invalid JSON from bridge: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

/**
 * Poll every enabled Tuya device, map raw DP→value pairs to named metrics,
 * and write them into the time-series + latest-metric tables.
 *
 * Called by server.js on the 30-second polling cycle.
 */
async function pollTuyaDevices() {
  let raw;
  try {
    raw = getConfig('tuya_devices');
  } catch (e) {
    logger.debug('Tuya: could not read tuya_devices config');
    return;
  }

  let devices;
  try {
    devices = JSON.parse(raw || '[]');
  } catch (e) {
    logger.error('Tuya: failed to parse tuya_devices config:', e.message);
    return;
  }

  if (!Array.isArray(devices) || !devices.length) return;

  for (const device of devices) {
    if (!device || !device.enabled) continue;
    if (!device.dev_id || !device.address || !device.local_key) {
      logger.debug(`Tuya: skipping "${device.name || 'unnamed'}" — missing dev_id/address/local_key`);
      continue;
    }

    const version = device.version || '3.3';
    const bridgePath = path.join(__dirname, 'tuya_bridge.py');

    try {
      // poll returns raw DP map e.g. {"1": 85, "2": 230}
      const dps = await runBridge(bridgePath, [
        'poll', device.dev_id, device.address, device.local_key, version
      ]);

      if (!dps || typeof dps !== 'object') {
        logger.debug(`Tuya poll (${device.name || device.dev_id}): no DPs returned`);
        continue;
      }

      // Map DP numbers → named metrics via device.dps { metricName: dpNumber }
      const dpsConfig = device.dps || {};
      const now = Math.floor(Date.now() / 1000);
      let written = 0;

      for (const [metricName, dpNumber] of Object.entries(dpsConfig)) {
        const dpKey = String(dpNumber);
        if (dps[dpKey] === undefined || dps[dpKey] === null) continue;
        let val = parseFloat(dps[dpKey]);
        if (isNaN(val)) continue;

        getMetricInsert().run(now, metricName, val);
        getLatestUpsert().run(metricName, val, now);
        written++;
      }

      logger.debug(
        `Tuya poll (${device.name || device.dev_id}): ${written} metrics from ${Object.keys(dps).length} DPs`
      );
    } catch (e) {
      logger.error(`Tuya poll error for "${device.name || device.dev_id}": ${e.message}`);
    }
  }
}

/**
 * Fetch devices + local keys + DP name mappings from the Tuya IoT Cloud.
 *
 * @param {string} region       - Tuya datacenter region (eu / us / cn / in)
 * @param {string} accessId     - Tuya API access ID
 * @param {string} accessSecret - Tuya API access secret
 * @param {string} deviceId     - any device ID on the account (used to select the API project)
 * @returns {Promise<Array<{name, id, key, ip, version, mapping}>>}
 */
async function fetchCloudDevices(region, accessId, accessSecret, userId) {
  const scriptPath = path.join(__dirname, 'tuya_cloud.py');
  const args = ['fetch-devices', region, accessId, accessSecret, userId];
  return runBridge(scriptPath, args);
}

/**
 * Parse the free-form text output of `python3 -m tinytuya scan`.
 * Tries JSON first; falls back to regex extraction of Device ID + IP + Version.
 *
 * @param {string} stdout - raw stdout from the scan process
 * @returns {Array<{dev_id: string, ip: string, version: string}>}
 */
function parseScanOutput(stdout) {
  // 1. Try JSON (some tinytuya versions / wrappers emit structured output)
  try {
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) {
      return parsed.map(d => ({
        dev_id: d.id || d.dev_id || d.devId || '',
        ip: d.ip || '',
        version: d.version || d.ver || ''
      }));
    }
  } catch (_) { /* fall through */ }

  // 2. Regex fallback — typical tinytuya scan prints tabular rows like:
  //    Device ID: bf1234567890, IP: 192.168.1.100, Version: 3.3
  const devices = [];
  const lines = stdout.split('\n');

  for (const line of lines) {
    const idMatch  = line.match(/(?:Device\s*ID|ID|device_id|dev_id)[:=\s]+([a-fA-F0-9]{10,})/i);
    const ipMatch  = line.match(/(?:IP|ip|address)[:=\s]+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i);

    if (idMatch && ipMatch) {
      const verMatch = line.match(/(?:Version|ver|v)[:=\s]+([\d.]+)/i);
      devices.push({
        dev_id: idMatch[1],
        ip: ipMatch[1],
        version: verMatch ? verMatch[1] : ''
      });
    }
  }

  return devices;
}

/**
 * Run a UDP broadcast scan for Tuya devices on the LAN.
 * Calls `python3 -m tinytuya scan` with a 25-second timeout.
 *
 * @returns {Promise<Array<{dev_id: string, ip: string, version: string}>>}
 */
/**
 * Discover Tuya devices on the LAN.
 *
 * @param {string} [subnet] - Optional subnet in CIDR notation (e.g. "192.168.0.0/24").
 *   When provided, scans every IP in the subnet via TCP probe to port 6668.
 *   When omitted, does a UDP broadcast scan (same-subnet only).
 * @returns {Promise<Array<{dev_id: string, ip: string, version: string}>>}
 */
async function discoverTuyaDevices(subnet) {
  if (subnet) {
    // Directed scan — probes every IP in the subnet via TCP 6668.
    // Works across routed subnets. Uses tuya_bridge.py discover action.
    const script = path.join(__dirname, 'tuya_bridge.py');
    return runBridge(script, ['discover', subnet]);
  }

  // UDP broadcast scan (original behaviour, same-subnet only)
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-m', 'tinytuya', 'scan'], { timeout: 30000 });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      if (stdout.trim()) {
        try {
          const devices = parseScanOutput(stdout);
          if (devices.length) return resolve(devices);
        } catch (_) { /* fall through */ }
      }
      reject(new Error('Discovery timed out — no Tuya devices replied within 25 seconds'));
    }, 25000);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0 && stdout.trim()) {
        try {
          resolve(parseScanOutput(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse scan output: ${e.message}`));
        }
      } else if (stderr.trim()) {
        reject(new Error(stderr.trim()));
      } else {
        reject(new Error(`Scan process exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start tinytuya scan: ${err.message}`));
    });
  });
}

/**
 * Probe a single Tuya device to verify LAN connectivity.
 *
 * @param {{dev_id: string, address: string, local_key: string, version?: string}} device
 * @returns {Promise<{success: boolean, dps?: object, error?: string}>}
 */
async function testTuyaDevice({ dev_id, address, local_key, version } = {}) {
  if (!dev_id || !address || !local_key) {
    return { success: false, error: 'Device ID, IP, and Local Key are required' };
  }

  const bridgePath = path.join(__dirname, 'tuya_bridge.py');
  const ver = version || '3.3';

  try {
    return await runBridge(bridgePath, ['test', dev_id, address, local_key, ver]);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function importTuyaFromHA() {
  const scriptPath = path.join(__dirname, 'tuya_import_ha.py');
  return runBridge(scriptPath, []);
}

module.exports = { pollTuyaDevices, fetchCloudDevices, discoverTuyaDevices, testTuyaDevice, importTuyaFromHA };
