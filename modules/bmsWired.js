/**
 * BMS Wired (Modbus-RTU Serial) Poller.
 *
 * Dedicated poller for BMS devices connected over a direct serial Modbus-RTU
 * link (RS-485/USB). This is a NET-NEW transport for the BMS subsystem — it
 * does NOT reuse rs232.js (which is the generic RS232 inverter engine) and it
 * never routes a wired BMS under the Dongle.
 *
 * It reuses the shared Modbus RTU framing primitives from modules/modbus-frame.js
 * and mirrors the serial/read logic of modules/rs232.js's pollModbusRtuDevice()
 * (which does NOT export its internals, so the serial + register decode logic is
 * reimplemented here). Metrics are published under the existing
 * `bms_<deviceName>_<field>` convention so bank aggregation, dashboard and
 * mapping work UNCHANGED (see modules/bmsAggregator.js readLatestBmsMetrics).
 *
 * Bank aggregation is intentionally kept central in modules/bms.js — this
 * module ONLY polls wired devices and writes bms_* metrics. The BMS loop in
 * bms.js reads latest_metrics, which both the BLE and the wired poller write to.
 *
 * @module bmsWired
 */

const { SerialPort } = require('serialport');
const fs = require('fs');
const path = require('path');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');
const {
  buildModbusReadRequest,
  buildPollRanges,
  parseModbusReadResponse,
  frameByteCount,
} = require('./modbus-frame');

let bmsWiredPollInterval = null;
let bmsWiredPollingActive = false;

// Profile cache: id (filename without .json) → normalized profile object
let availableProfiles = new Map();

// ── Profile Loading (mirrors rs232.js loadRs232Profiles) ─────────────────

function loadBmsWiredProfiles() {
  const profilesDir = path.join(__dirname, '../profiles/rs232');
  availableProfiles = new Map();
  if (!fs.existsSync(profilesDir)) return;
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(profilesDir, file), 'utf8');
      const profile = JSON.parse(raw);
      const id = file.replace('.json', '');
      availableProfiles.set(id, {
        id,
        name: profile.name || file,
        protocol: profile.protocol || 'modbus-rtu',
        transport: profile.transport || 'rs232',
        defaults: profile.defaults || { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
        metrics: profile.metrics || [],
        byte_order: profile.byte_order || null,
        default_unit_id: profile.default_unit_id || null,
      });
    } catch (e) {
      logger.error(`BMS-wired: failed to parse RS232 profile ${file}: ${e.message}`);
    }
  }
  logger.info(`BMS-wired: loaded ${availableProfiles.size} profile(s).`);
}

// ── Profile Load-by-Id (used by the test + fields routes) ──────────────

/**
 * Load and normalize a single RS232 profile fresh from disk by id
 * (filename without .json). Mirrors the normalization in loadBmsWiredProfiles
 * but reads the file directly, so test/fields routes never depend on the
 * aggregate map being freshly populated.
 * @param {string} id — profile id (filename without .json)
 * @returns {object|null} normalized profile, or null if missing/unparseable
 */
function loadProfileById(id) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  const profilePath = path.join(__dirname, '../profiles/rs232', `${safeId}.json`);
  if (!fs.existsSync(profilePath)) return null;
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    return {
      id: safeId,
      name: profile.name || safeId,
      protocol: profile.protocol || 'modbus-rtu',
      transport: profile.transport || 'rs232',
      defaults: profile.defaults || { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
      metrics: profile.metrics || [],
      byte_order: profile.byte_order || null,
      default_unit_id: profile.default_unit_id || null,
    };
  } catch (e) {
    logger.error(`BMS-wired: failed to parse profile ${safeId}: ${e.message}`);
    return null;
  }
}

// ── Serial Port Helpers (mirror rs232.js openSerialPort) ─────────────────

function openSerialPort(device, profile) {
  return new Promise((resolve, reject) => {
    const defaults = (profile && profile.defaults) || {};
    const port = new SerialPort({
      path: device.serial_path || '/dev/ttyUSB0',
      baudRate: parseInt(device.baud, 10) || parseInt(defaults.baud, 10) || 9600,
      dataBits: parseInt(device.data_bits, 10) || parseInt(defaults.dataBits, 10) || 8,
      stopBits: parseInt(device.stop_bits, 10) || parseInt(defaults.stopBits, 10) || 1,
      parity: device.parity || defaults.parity || 'none',
      autoOpen: false,
    });

    port.open(err => {
      if (err) {
        if (err.message.includes('EACCES')) {
          reject(new Error(`Permission denied on ${device.serial_path}. Add user to 'dialout' group: sudo usermod -a -G dialout $USER`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`Port ${device.serial_path} not found. Check USB connection.`));
        } else {
          reject(err);
        }
      } else {
        resolve(port);
      }
    });
  });
}

function closeSerialPort(port) {
  return new Promise(resolve => {
    if (!port || !port.isOpen) return resolve();
    port.close(() => resolve());
  });
}

// ── Modbus-RTU Frame Read (mirror rs232.js readModbusRtuFrame) ────────────

/**
 * Write a Modbus-RTU frame to the port and read a single complete response
 * frame. Uses frameByteCount() to detect the full frame (3 + byteCount + 2).
 * @param {import('serialport').SerialPort} port
 * @param {Buffer} frame — a complete request frame (incl. CRC)
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>} the complete response frame
 */
function readModbusRtuFrame(port, frame, timeoutMs = 5000) {
  const safeTimeout = Math.min(Math.max(parseInt(timeoutMs, 10) || 5000, 100), 30000);
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      port.removeAllListeners('data');
      reject(new Error('Modbus-RTU read timeout'));
    }, safeTimeout);

    port.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 3) {
        const total = frameByteCount(buffer);
        if (total > 0 && buffer.length >= total) {
          clearTimeout(timer);
          port.removeAllListeners('data');
          resolve(buffer.slice(0, total));
          return;
        }
      }
      timer.refresh();
    });

    port.write(frame, err => {
      if (err) {
        clearTimeout(timer);
        port.removeAllListeners('data');
        reject(err);
      }
    });
  });
}

// ── DB Metric Helpers (mirror bms.js saveBmsMetric) ──────────────────────

let bmsMetricInsert = null;
let bmsLatestUpsert = null;
let bmsMetricInsertText = null;
let bmsLatestUpsertText = null;

function getBmsMetricInsert(db) {
  if (!bmsMetricInsert) bmsMetricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  return bmsMetricInsert;
}

function getBmsLatestUpsert(db) {
  if (!bmsLatestUpsert) bmsLatestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  return bmsLatestUpsert;
}

function getBmsMetricInsertText(db) {
  if (!bmsMetricInsertText) bmsMetricInsertText = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  return bmsMetricInsertText;
}

function getBmsLatestUpsertText(db) {
  if (!bmsLatestUpsertText) bmsLatestUpsertText = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp) VALUES (?, ?, ?, ?)');
  return bmsLatestUpsertText;
}

function saveBmsMetric(db, metricName, rawValue, timestamp) {
  if (rawValue === null || rawValue === undefined) return;
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return;
  const num = parseFloat(rawValue);
  if (!isNaN(num) && num === Number(rawValue)) {
    getBmsLatestUpsert(db).run(metricName, num, timestamp);
    getBmsMetricInsert(db).run(timestamp, metricName, num);
  } else {
    const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
    const lower = strVal.toLowerCase();
    const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
    const type = isBool ? 'boolean' : 'string';
    const displayVal = isBool ? lower : strVal;
    getBmsLatestUpsertText(db).run(metricName, displayVal, type, timestamp);
    getBmsMetricInsertText(db).run(timestamp, metricName, displayVal, type);
  }
}

// ── Device Poll (mirror rs232.js pollModbusRtuDevice, publish bms_*) ──────

async function pollWiredDevice(device, profile, db) {
  const port = await openSerialPort(device, profile);
  try {
    const unitId = device.modbus_unit_id || profile.default_unit_id || 5;
    const ranges = buildPollRanges(profile.metrics);
    const registerData = {};

    for (const range of ranges) {
      const frame = buildModbusReadRequest(unitId, 0x03, range.start, range.count);
      const resp = await readModbusRtuFrame(port, frame, parseInt(device.timeout, 10) || 5000);
      const buf = parseModbusReadResponse(resp);
      if (buf.length < range.count * 2) {
        logger.warn(`[bmsWired] ${device.name}: short buffer at range ${range.start} (expected ${range.count} regs, got ${buf.length / 2})`);
      }
      const leSwap = profile.byte_order === 'le';
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        let v = buf.readUInt16BE(i * 2);
        if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
        registerData[range.start + i] = v;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    let writeCount = 0;
    for (const m of profile.metrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;

      if (m.bit !== undefined) raw = (raw >> m.bit) & 1;
      if (m.type === 'int16') raw = raw > 0x7FFF ? raw - 0x10000 : raw;
      if (m.type === 'uint32' || m.type === 'int32') {
        const lo = m.word_order === 'lsb_first' ? addr : addr + 1;
        const hi = m.word_order === 'lsb_first' ? addr + 1 : addr;
        raw = ((registerData[hi] || 0) << 16) | (registerData[lo] || 0);
        if (m.type === 'int32' && raw > 0x7FFFFFFF) raw -= 0x100000000;
      }
      if (m.type === 'uint64') {
        raw = ((registerData[addr + 3] || 0) * 0x1000000000000)
            + ((registerData[addr + 2] || 0) * 0x100000000)
            + ((registerData[addr + 1] || 0) << 16)
            + (registerData[addr] || 0);
      }

      const value = parseFloat((raw * (m.scale || 1)).toFixed(4));
      // D-3E: publish under the existing bms_<deviceName>_<field> convention.
      // Prefer m.field, fall back to m.name.
      const key = m.field || m.name;
      const metricName = `bms_${device.name}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');
      saveBmsMetric(db, metricName, value, now);
      writeCount++;
      // Publish the mapped role-metric alias (parity with BLE poller).
      const wiredMappings = device.mappings || {};
      if (wiredMappings[key]) saveBmsMetric(db, wiredMappings[key], value, now);
    }
    logger.info(`BMS-wired poll ${device.name} (unit ${unitId}): ${writeCount} metrics`);
  } finally {
    await closeSerialPort(port);
  }
}

/**
 * Poll every enabled WIRED BMS device (transport === 'wired') and write its
 * metrics as bms_<deviceName>_<field>. On any per-device failure, the device is
 * logged and SKIPPED — the loop never throws. Bank aggregation is NOT done here;
 * that stays central in bms.js.
 */
async function pollBmsWired() {
  if (bmsWiredPollingActive) {
    logger.warn('BMS-wired poll skipped — previous cycle still running');
    return;
  }
  bmsWiredPollingActive = true;
  try {
    const db = getDb();
    let devices;
    try {
      devices = JSON.parse(getConfig('bms_devices') || '[]');
    } catch (e) {
      logger.error(`BMS-wired: failed to parse bms_devices config: ${e.message}`);
      return;
    }
    if (!devices.length) return;

    for (const device of devices) {
      if (!device.enabled || device.transport !== 'wired') continue;
      if (!device.serial_path) {
        logger.warn(`BMS-wired ${device.name}: no serial_path set — skipping`);
        continue;
      }
      const profile = availableProfiles.get(device.profile);
      if (!profile) {
        logger.error(`BMS-wired ${device.name}: profile '${device.profile}' not found — skipping`);
        continue;
      }
      try {
        await pollWiredDevice(device, profile, db);
      } catch (err) {
        logger.error(`BMS-wired poll error for ${device.name}: ${err.message}`);
      }
    }
  } finally {
    bmsWiredPollingActive = false;
  }
}

// ── Test / Fields (for the BMS-wired API routes) ───────────────────────

/**
 * Open a one-off test connection to a wired BMS device and read its registers
 * WITHOUT writing anything to the DB. Performs the same FC 0x03 reads and
 * register transforms as pollWiredDevice, then returns a flat
 * { <field>: value, ... } object (m.field preferred, else m.name).
 *
 * The device object mirrors the wired BMS device config:
 *   { serial_path, baud, data_bits, stop_bits, parity, modbus_unit_id,
 *     profile, timeout, name? }
 *
 * On failure it throws a clear Error (port not found / permission denied /
 * no response from unit N / short buffer). It DOES NOT swallow — the caller
 * (route) catches and surfaces the message.
 * @param {object} device — wired BMS device config (see body shape above)
 * @returns {Promise<object>} { <field>: value, ... }
 */
async function testBmsWiredConnection(device) {
  const profile = loadProfileById(device.profile);
  if (!profile) throw new Error(`Profile '${device.profile}' not found`);

  let port;
  try {
    port = await openSerialPort(device, profile);
  } catch (err) {
    const msg = err.message || String(err);
    if (/(EACCES|permission denied|dialout)/i.test(msg)) {
      throw new Error(`Serial permission denied — add user to dialout group (port ${device.serial_path || 'unknown'})`);
    }
    if (/(ENOENT|not found)/i.test(msg)) {
      throw new Error(`Port not found: ${device.serial_path || 'unknown'}`);
    }
    throw err;
  }

  try {
    const unitId = device.modbus_unit_id || profile.default_unit_id || 5;
    const ranges = buildPollRanges(profile.metrics);
    if (!ranges.length) throw new Error('No poll ranges defined in profile');
    const registerData = {};

    for (const range of ranges) {
      const frame = buildModbusReadRequest(unitId, 0x03, range.start, range.count);
      let resp;
      try {
        resp = await readModbusRtuFrame(port, frame, parseInt(device.timeout, 10) || 5000);
      } catch (err) {
        if (err.message === 'Modbus-RTU read timeout') {
          throw new Error(`No response from unit ${unitId}`);
        }
        throw err;
      }
      const buf = parseModbusReadResponse(resp);
      if (buf.length < range.count * 2) {
        throw new Error(`Short buffer at range ${range.start} (expected ${range.count} regs, got ${buf.length / 2})`);
      }
      const leSwap = profile.byte_order === 'le';
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        let v = buf.readUInt16BE(i * 2);
        if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
        registerData[range.start + i] = v;
      }
    }

    const result = {};
    for (const m of profile.metrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;
      if (m.bit !== undefined) raw = (raw >> m.bit) & 1;
      if (m.type === 'int16') raw = raw > 0x7FFF ? raw - 0x10000 : raw;
      if (m.type === 'uint32' || m.type === 'int32') {
        const lo = m.word_order === 'lsb_first' ? addr : addr + 1;
        const hi = m.word_order === 'lsb_first' ? addr + 1 : addr;
        raw = ((registerData[hi] || 0) << 16) | (registerData[lo] || 0);
        if (m.type === 'int32' && raw > 0x7FFFFFFF) raw -= 0x100000000;
      }
      if (m.type === 'uint64') {
        raw = ((registerData[addr + 3] || 0) * 0x1000000000000)
            + ((registerData[addr + 2] || 0) * 0x100000000)
            + ((registerData[addr + 1] || 0) << 16)
            + (registerData[addr] || 0);
      }
      const value = parseFloat((raw * (m.scale || 1)).toFixed(4));
      const key = m.field || m.name;
      result[key] = value;
    }
    return result;
  } finally {
    await closeSerialPort(port);
  }
}

/**
 * Return the metric descriptors for a wired BMS profile without opening any
 * serial port. Used by the front-end to render test rows.
 * @param {string} profileId — profile id (filename without .json)
 * @returns {Promise<Array<{field: string, label: string, unit: string}>>}
 */
async function getBmsWiredFields(profileId) {
  const profile = loadProfileById(profileId);
  if (!profile) return [];
  return (profile.metrics || []).map(m => ({
    field: m.field || m.name,
    label: m.label || m.name,
    unit: m.unit || '',
  }));
}

// ── Module Lifecycle API (mirror bms.js) ─────────────────────────────────

function startBmsWiredPolling() {
  if (bmsWiredPollInterval) clearInterval(bmsWiredPollInterval);
  loadBmsWiredProfiles();
  const intervalSec = parseInt(getConfig('bms_poll_interval'), 10) || 30;
  logger.info(`BMS-wired polling started: interval=${intervalSec}s`);
  bmsWiredPollInterval = setInterval(pollBmsWired, intervalSec * 1000);
  pollBmsWired().catch(err => logger.error('BMS-wired initial poll failed:', err.message)); // immediate first run
}

function restartBmsWiredPolling() {
  startBmsWiredPolling();
}

function stopBmsWiredPolling() {
  if (bmsWiredPollInterval) {
    clearInterval(bmsWiredPollInterval);
    bmsWiredPollInterval = null;
  }
  bmsWiredPollingActive = false;
}

// Load profiles eagerly so the map is available before the first poll.
loadBmsWiredProfiles();

module.exports = {
  startBmsWiredPolling,
  restartBmsWiredPolling,
  stopBmsWiredPolling,
  pollBmsWired,
  loadBmsWiredProfiles,
  testBmsWiredConnection,
  getBmsWiredFields,
};
