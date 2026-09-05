/**
 * Inverter Dongle Module — polls inverter WiFi dongles via Solarman V5, Modbus TCP, or Growatt.
 *
 * Each enabled dongle instance is polled on its own interval. Solarman V5 and Modbus TCP
 * use outgoing TCP connections (poll-based). Growatt uses an inbound TCP server (push-based).
 *
 * Metrics are written to the central metrics/latest_metrics store, same as HA, MQTT, and Modbus.
 *
 * @module dongle
 */
const fs = require('fs');
const path = require('path');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');
const { SolarmanV5Transport } = require('./dongle/solarmanV5');
const { GrowattServer } = require('./dongle/growatt');
const { ModbusTcpTransport } = require('./dongle/modbusTcp');
const { FelicityTcpTransport } = require('./dongle/felicityTcp');
const { LuxpowerTcpTransport } = require('./dongle/luxpowerTcp');

let pollIntervals = [];
let growattServer = null;
let luxpowerPollers = [];
const profileCache = new Map();

function startDonglePolling() {
  stopDonglePolling();

  const raw = getConfig('dongle_config');
  if (!raw || raw === '[]') return;

  let config;
  try { config = JSON.parse(raw); } catch (e) { logger.error('[dongle] invalid config JSON'); return; }

  const growattInstances = [];

  for (const inst of config) {
    if (!inst.enabled) continue;

    if (inst.transport === 'growatt') {
      growattInstances.push(inst);
      continue;
    }

    const profile = loadProfile(inst.profile);
    if (!profile) { logger.warn(`[dongle] profile ${inst.profile} not found for ${inst.name}`); continue; }

    if (profile.protocol === 'felicity-tcp') {
      const transport = new FelicityTcpTransport(inst);
      const intervalMs = (inst.poll_interval || 30) * 1000;
      const id = setInterval(() => pollJsonInstance(inst, transport, profile), intervalMs);
      pollIntervals.push(id);
      pollJsonInstance(inst, transport, profile).catch(err => logger.warn(`[dongle] ${inst.name}: initial poll failed — ${err.message}`));
      continue;
    }

    if (profile.protocol === 'luxpower-tcp') {
      // LuxPower local TCP (v5 TranslatedData on :8000). Config uses explicit
      // dongle_serial (outer header) + inverter_serial (inner 10-char serial);
      // tolerate devices that stored the inverter serial under serial_number.
      let transport = null;
      try {
        transport = new LuxpowerTcpTransport({
          host: inst.host || inst.ip,
          port: inst.port || 8000,
          dongle_serial: inst.dongle_serial,
          inverter_serial: inst.inverter_serial || inst.serial_number,
          onFrame: parsed => handleLuxpowerFrame(inst, parsed)
        });
        // D4 (revised): ~5s active input cadence for luxpower-tcp; honor an
        // explicit poll_interval (seconds) when the instance sets one.
        const intervalMs = (inst.poll_interval || 5) * 1000;
        const id = setInterval(() => pollLuxpowerInstance(inst, transport, profile), intervalMs);
        luxpowerPollers.push({ instance: inst, transport, intervalId: id });
        transport.start();
        pollLuxpowerInstance(inst, transport, profile).catch(err => logger.warn(`[dongle] ${inst.name}: initial poll failed — ${err.message}`));
      } catch (err) {
        if (transport) { try { transport.stop(); } catch (_) {} }
        logger.warn(`[dongle] ${inst.name}: luxpower instance skipped — ${err.message}`);
        continue;
      }
      continue;
    }

    profile.poll_ranges = buildPollRanges(profile.metrics);

    let Transport = ModbusTcpTransport;
    if (inst.transport === 'solarman-v5') Transport = SolarmanV5Transport;
    const transport = new Transport(inst);

    const intervalMs = (inst.poll_interval || 30) * 1000;
    const id = setInterval(() => pollInstance(inst, transport, profile), intervalMs);
    pollIntervals.push(id);
    pollInstance(inst, transport, profile).catch(err => logger.warn(`[dongle] ${inst.name}: initial poll failed — ${err.message}`));
  }

  if (growattInstances.length > 0) {
    growattServer = new GrowattServer(growattInstances, writeMetrics);
    growattServer.start();
  }
}

function stopDonglePolling() {
  pollIntervals.forEach(clearInterval);
  pollIntervals = [];
  for (const entry of luxpowerPollers) {
    clearInterval(entry.intervalId);
    if (entry.transport) entry.transport.stop();
  }
  luxpowerPollers = [];
  if (growattServer) { growattServer.stop(); growattServer = null; }
}

function restartDonglePolling() { startDonglePolling(); }

function writeMetrics(metrics, units) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)');
  const metricInsertText = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  const latestUpsertText = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp, unit) VALUES (?, ?, ?, ?, ?)');
  for (const [name, rawValue] of Object.entries(metrics)) {
    if (rawValue === undefined || rawValue === null) continue;
    const num = parseFloat(rawValue);
    if (!isNaN(num) && num === Number(rawValue)) {
      metricInsert.run(now, name, num);
      latestUpsert.run(name, num, now, (units && units[name]) || null);
    } else {
      const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
      const lower = strVal.toLowerCase();
      const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
      const type = isBool ? 'boolean' : 'string';
      const displayVal = isBool ? lower : strVal;
      metricInsertText.run(now, name, displayVal, type);
      latestUpsertText.run(name, displayVal, type, now, (units && units[name]) || null);
    }
  }
}

function loadProfile(profileId) {
  if (profileCache.has(profileId)) {
    return profileCache.get(profileId);
  }
  const profilePath = path.join(__dirname, '..', 'profiles', 'dongles', `${profileId}.json`);
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profileCache.set(profileId, profile);
    return profile;
  } catch (e) {
    logger.error(`[dongle] Failed to load profile ${profileId}: ${e.message}`);
    return null;
  }
}

function buildPollRanges(metrics) {
  const addresses = metrics
    .map(m => ({ addr: parseInt(m.register, 16), count: m.count || 1 }))
    .sort((a, b) => a.addr - b.addr);

  const ranges = [];
  for (const item of addresses) {
    const last = ranges[ranges.length - 1];
    if (last && item.addr <= last.start + last.count + 4) {
      const newEnd = Math.max(last.start + last.count, item.addr + item.count);
      last.count = newEnd - last.start;
    } else {
      ranges.push({ start: item.addr, count: item.count });
    }
  }
  return ranges;
}

async function pollInstance(instance, transport, profile) {
  try {
    const registerData = {};
    const start = Date.now();

    for (const range of profile.poll_ranges) {
      const buf = await transport.readRegisters(range.start, range.count);
      if (buf.length < range.count * 2) {
        logger.warn(`[dongle] ${instance.name}: short buffer at range ${range.start} (expected ${range.count} regs, got ${buf.length / 2})`);
      }
      const leSwap = profile.byte_order === 'le';
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        let v = buf.readUInt16BE(i * 2);
        if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
        registerData[range.start + i] = v;
      }
    }

    const metrics = {};
    const units = {};
    const prefix = instance.prefix || '';
    const mappings = instance.mappings || null;
    // Build reverse lookup: register → metric name (mappings is { metricName → register })
    let regToMetric = null;
    if (mappings) {
      regToMetric = {};
      for (const [metric, reg] of Object.entries(mappings)) {
        regToMetric[reg] = metric;
      }
    }

    for (const m of profile.metrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;

      // Mapping override logic
      let metricName;
      if (regToMetric) {
        const key = m.register; // e.g., "0x0065"
        if (regToMetric[key] !== undefined) {
          metricName = regToMetric[key];
        } else {
          // Key not in mappings at all — skip unmapped when mappings exist
          continue;
        }
      } else {
        metricName = prefix + m.name;
      }

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
      metrics[metricName] = value;
      if (m.unit) units[metricName] = m.unit;
    }

    writeMetrics(metrics, units);
    instance.lastSeen = Date.now();
    instance.consecutiveFails = 0;
    logger.debug(`[dongle] ${instance.name}: ${Object.keys(metrics).length} metrics in ${Date.now() - start}ms`);

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.consecutiveFails = (instance.consecutiveFails || 0) + 1;
  }
}

async function pollJsonInstance(instance, transport, profile) {
  try {
    const start = Date.now();
    const data = await transport.poll();

    const metrics = {};
    const units = {};
    const prefix = instance.prefix || '';
    const mappings = instance.mappings || null;
    // Build reverse lookup: path → metric name (mappings is { metricName → path })
    let pathToMetric = null;
    if (mappings) {
      pathToMetric = {};
      for (const [metric, key] of Object.entries(mappings)) {
        pathToMetric[key] = metric;
      }
    }

    for (const field of profile.fields) {
      let raw = getByPath(data, field.path);
      if (raw === undefined || raw === null || (typeof raw === 'number' && isNaN(raw))) continue;

      // Mapping override logic
      let metricName;
      if (pathToMetric) {
        const key = field.path; // e.g., "realtime.ACin[0][0]"
        if (pathToMetric[key] !== undefined) {
          metricName = pathToMetric[key];
        } else {
          continue; // skip unmapped when mappings exist
        }
      } else {
        metricName = prefix + field.name;
      }

      if (typeof raw === 'string') {
        raw = parseInt(raw, 10);
        if (isNaN(raw)) continue;
      }

      const value = parseFloat((raw * (field.scale || 1)).toFixed(4));
      metrics[metricName] = value;
      if (field.unit) units[metricName] = field.unit;
    }

    writeMetrics(metrics, units);
    instance.lastSeen = Date.now();
    instance.consecutiveFails = 0;
    logger.debug(`[dongle] ${instance.name}: ${Object.keys(metrics).length} metrics in ${Date.now() - start}ms`);

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.consecutiveFails = (instance.consecutiveFails || 0) + 1;
  }
}

/**
 * LuxPower local-TCP poll cycle: active INPUT-register reads only (holding
 * metrics are out of scope in phase 1 — see D5). Ranges are derived from the
 * profile's register_type:'input' metrics; decoded values reuse the shared
 * Modbus-style decode semantics (int16/uint32/int32/uint64/bit/scale, honoring
 * profile.byte_order and instance.prefix/mappings) and are funneled into
 * writeMetrics. Mapping keys are namespaced input:0xNNNN / holding:0xNNNN for
 * register_type-carrying metrics (AC16); legacy bare-hex keys still match.
 */
async function pollLuxpowerInstance(instance, transport, profile) {
  try {
    const start = Date.now();
    const inputMetrics = profile.metrics.filter(m => (m.register_type || 'holding') === 'input');
    const registerData = {};

    for (const range of buildPollRanges(inputMetrics)) {
      const buf = await transport.readRegisters(range.start, range.count, 0x04);
      if (buf.length < range.count * 2) {
        logger.warn(`[dongle] ${instance.name}: short buffer at range ${range.start} (expected ${range.count} regs, got ${buf.length / 2})`);
      }
      const leSwap = profile.byte_order === 'le';
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        let v = buf.readUInt16BE(i * 2);
        if (leSwap) v = ((v & 0xFF) << 8) | (v >> 8);
        registerData[range.start + i] = v;
      }
    }

    const metrics = {};
    const units = {};
    const prefix = instance.prefix || '';
    const mappings = instance.mappings || null;
    // Build reverse lookup: (namespaced) register key → metric name
    let regToMetric = null;
    if (mappings) {
      regToMetric = {};
      for (const [metric, reg] of Object.entries(mappings)) {
        regToMetric[reg] = metric;
      }
    }

    for (const m of inputMetrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;

      // Mapping override logic — namespaced key first (AC16), then legacy bare
      // hex for configs saved before namespacing; unmapped → skip.
      let metricName;
      if (regToMetric) {
        const key = m.register_type ? `${m.register_type}:${m.register}` : m.register;
        metricName = regToMetric[key] !== undefined ? regToMetric[key] : regToMetric[m.register];
        if (metricName === undefined) continue;
      } else {
        metricName = prefix + m.name;
      }

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
      metrics[metricName] = value;
      if (m.unit) units[metricName] = m.unit;
    }

    writeMetrics(metrics, units);
    instance.lastSeen = Date.now();
    instance.consecutiveFails = 0;
    logger.debug(`[dongle] ${instance.name}: ${Object.keys(metrics).length} metrics in ${Date.now() - start}ms`);

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.consecutiveFails = (instance.consecutiveFails || 0) + 1;
  }
}

/**
 * Unsolicited LuxPower frames (e.g. holding pushes from the inverter) — treated
 * as liveness/diagnostics only in phase 1 (holding metrics are out of scope,
 * see D5). Updates lastSeen/consecutiveFails so a healthy push keeps the device
 * green between active polls.
 */
function handleLuxpowerFrame(instance, parsed) {
  instance.lastSeen = Date.now();
  instance.consecutiveFails = 0;
  logger.debug(`[dongle] ${instance.name}: unsolicited luxpower frame devFn=0x${parsed.devFn.toString(16)} start=0x${parsed.start.toString(16)} byteLen=${parsed.byteLen}`);
}

function getByPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    const match = part.match(/^(.+?)\[(\d+)\]\[(\d+)\]$/);
    if (match) {
      cur = cur[match[1]];
      if (!cur) return undefined;
      cur = cur[parseInt(match[2])];
      if (!cur) return undefined;
      cur = cur[parseInt(match[3])];
    } else {
      const arrMatch = part.match(/^(.+?)\[(\d+)\]$/);
      if (arrMatch) {
        cur = cur[arrMatch[1]];
        if (!cur) return undefined;
        cur = cur[parseInt(arrMatch[2])];
      } else {
        cur = cur[part];
      }
    }
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

function getProfileById(id) {
  const profilePath = path.join(__dirname, '..', 'profiles', 'dongles', `${id}.json`);
  try {
    if (profileCache.has(id)) return profileCache.get(id);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profileCache.set(id, profile);
    return profile;
  } catch (e) {
    return null;
  }
}

async function executeDongleAction(deviceName, registerAddr, value) {
  const devices = JSON.parse(getConfig('dongle_config') || '[]');
  const device = devices.find(d => d.name === deviceName);
  if (!device || !device.enabled) return { error: 'Dongle device not found or disabled' };

  const transportType = device.transport || 'modbus-tcp';

  // Growatt dongles are push-only (inbound TCP server) — writes are not supported.
  if (transportType === 'growatt') {
    return { error: 'Growatt not supported — push-only, write actions are not available' };
  }

  // Felicity inverters speak a proprietary JSON API, not Modbus registers.
  const profile = getProfileById(device.profile);
  if (transportType === 'felicity-tcp' || profile?.protocol === 'felicity-tcp') {
    return { error: 'felicity-tcp dongles use a proprietary JSON API and do not support Modbus register writes' };
  }

  // LuxPower local TCP is read-only in phase 1 — no 0x06/0x10 write support.
  if (transportType === 'luxpower-tcp' || profile?.protocol === 'luxpower-tcp') {
    return { error: 'luxpower-tcp is read-only in phase 1 — register writes are not supported' };
  }

  if (isNaN(parseInt(registerAddr))) {
    return { error: 'Invalid register address' };
  }
  const addr = parseInt(registerAddr);
  const val = parseInt(value) || 0;

  try {
    if (transportType === 'solarman-v5') {
      if (!device.serial_number) {
        return { error: 'solarman-v5 write requires serial_number in dongle config' };
      }
      const { SolarmanV5Transport } = require('./dongle/solarmanV5');
      const transport = new SolarmanV5Transport({
        host: device.host || device.ip,
        port: device.port || 8899,
        serial_number: device.serial_number,
        modbus_unit_id: device.modbus_unit_id || 1
      });
      await transport.writeRegister(addr, val);
      return { success: true };
    }

    if (transportType === 'modbus-rtu') {
      return { error: 'modbus-rtu has moved to the RS232 path; use rs232_devices + executeRs232Action for register writes' };
    }

    // Default: plain Modbus TCP (transport 'modbus-tcp' or unset)
    const { ModbusTcpTransport } = require('./dongle/modbusTcp');
    const transport = new ModbusTcpTransport({
      host: device.host || device.ip,
      port: device.port || 502,
      modbus_unit_id: device.modbus_unit_id || 1
    });
    await transport.writeRegister(addr, val);
    return { success: true };
  } catch (e) {
    logger.error(`Dongle write error for ${deviceName}/register ${registerAddr}: ${e.message}`);
    return { error: e.message };
  }
}

module.exports = { startDonglePolling, stopDonglePolling, restartDonglePolling, executeDongleAction, getProfileById };
