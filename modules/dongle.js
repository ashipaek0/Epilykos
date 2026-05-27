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

let pollIntervals = [];
let growattServer = null;

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
      pollJsonInstance(inst, transport, profile);
      continue;
    }

    profile.poll_ranges = buildPollRanges(profile.metrics);

    const Transport = inst.transport === 'solarman-v5' ? SolarmanV5Transport : ModbusTcpTransport;
    const transport = new Transport(inst);

    const intervalMs = (inst.poll_interval || 30) * 1000;
    const id = setInterval(() => pollInstance(inst, transport, profile), intervalMs);
    pollIntervals.push(id);
    pollInstance(inst, transport, profile);
  }

  if (growattInstances.length > 0) {
    growattServer = new GrowattServer(growattInstances, writeMetrics);
    growattServer.start();
  }
}

function stopDonglePolling() {
  pollIntervals.forEach(clearInterval);
  pollIntervals = [];
  if (growattServer) { growattServer.stop(); growattServer = null; }
}

function restartDonglePolling() { startDonglePolling(); }

function writeMetrics(metrics, units) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)');
  for (const [name, value] of Object.entries(metrics)) {
    if (value !== undefined && !isNaN(value)) {
      metricInsert.run(now, name, value);
      latestUpsert.run(name, value, now, (units && units[name]) || null);
    }
  }
}

function loadProfile(profileId) {
  const profilePath = path.join(__dirname, '..', 'profiles', 'dongles', `${profileId}.json`);
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
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
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        registerData[range.start + i] = buf.readUInt16BE(i * 2);
      }
    }

    const metrics = {};
    const units = {};
    const prefix = instance.prefix || '';
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
      const name = prefix + m.name;
      metrics[name] = value;
      if (m.unit) units[name] = m.unit;
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
    for (const field of profile.fields) {
      let raw = getByPath(data, field.path);
      if (raw === undefined || raw === null || (typeof raw === 'number' && isNaN(raw))) continue;

      if (typeof raw === 'string') {
        raw = parseInt(raw, 10);
        if (isNaN(raw)) continue;
      }

      const value = parseFloat((raw * (field.scale || 1)).toFixed(4));
      const name = prefix + field.name;
      metrics[name] = value;
      if (field.unit) units[name] = field.unit;
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

module.exports = { startDonglePolling, restartDonglePolling };
