# Epilykos — Inverter Dongle Module: Code Implementation Plan

**Status:** Ready for implementation  
**Estimated effort:** 6–8 days (Phases 1–4)  
**Dependencies:** None (pure Node.js `net` module)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Module Contract](#2-module-contract)
3. [Transport Implementations](#3-transport-implementations)
   - 3.1 Solarman V5
   - 3.2 Growatt (TCP Server Mode)
   - 3.3 Plain Modbus TCP (Sofar + Voltronic)
4. [Profile JSON Format](#4-profile-json-format)
5. [Backend Integration](#5-backend-integration)
6. [Settings UI](#6-settings-ui)
7. [Error Handling & Resilience](#7-error-handling)
8. [Implementation Order](#8-implementation-order)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    server.js                         │
│  startDonglePolling() / restartDonglePolling()      │
├──────────────────────────────────────────────────────┤
│                  modules/dongle.js                   │
│  ┌─────────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ solarmanV5  │ │ growatt  │ │   modbusTcp      │  │
│  │ (TCP client)│ │(TCP srv) │ │  (TCP client)     │  │
│  └─────────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────────────────────────────────────────┐   │
│  │              crc.js (shared)                  │   │
│  │  Modbus CRC-16, V5 checksum, frame helpers   │   │
│  └──────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────┤
│              profiles/dongles/*.json                 │
│  srne-hybrid, deye-hybrid, growatt-spf, etc         │
├──────────────────────────────────────────────────────┤
│            latest_metrics + metrics tables           │
└──────────────────────────────────────────────────────┘
```

**Key design decisions:**
- No native npm dependencies — pure Node.js `net`, `events`, `Buffer`
- Each dongle instance gets its own transport object + poll interval
- Solarman V5 and Modbus TCP are **poll-based** (setInterval)
- Growatt is **push-based** (TCP server receives data)
- All transports write to the same metrics store

---

## 2. Module Contract

`modules/dongle.js` exports the same pattern as every other source module:

```javascript
// modules/dongle.js
const fs = require('fs');
const path = require('path');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');
const { SolarmanV5Transport } = require('./dongle/solarmanV5');
const { GrowattServer } = require('./dongle/growatt');
const { ModbusTcpTransport } = require('./dongle/modbusTcp');

let pollIntervals = [];
let growattServer = null;

async function startDonglePolling() {
  stopDonglePolling();  // Clean up any existing instances
  const config = JSON.parse(getConfig('dongle_config') || '[]');
  
  for (const inst of config) {
    if (!inst.enabled) continue;
    const profile = loadProfile(inst.profile);
    if (!profile) { logger.warn(`[dongle] profile ${inst.profile} not found`); continue; }
    
    if (inst.transport === 'growatt') {
      // Growatt: TCP server — start once, handles all instances
      // Pass writeMetrics so the server can write directly to the store
      if (!growattServer) growattServer = new GrowattServer(config, writeMetrics);
    } else {
      // Solarman V5 or Modbus TCP: poll-based
      const transport = inst.transport === 'solarman-v5'
        ? new SolarmanV5Transport(inst, profile)
        : new ModbusTcpTransport(inst, profile);
      
      const interval = setInterval(() => pollInstance(inst, transport, profile), (inst.poll_interval || 30) * 1000);
      pollIntervals.push(interval);
      pollInstance(inst, transport, profile); // Immediate first poll
    }
  }
}

function stopDonglePolling() {
  pollIntervals.forEach(clearInterval);
  pollIntervals = [];
  if (growattServer) { growattServer.stop(); growattServer = null; }
}

function restartDonglePolling() { startDonglePolling(); }

/**
 * Write named metrics to the central store.
 * Matches the same pattern as ha.js / mqtt.js / modbus.js.
 */
function writeMetrics(metrics) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  for (const [name, value] of Object.entries(metrics)) {
    if (value !== undefined && !isNaN(value)) {
      metricInsert.run(now, name, value);
      latestUpsert.run(name, value, now);
    }
  }
}

/**
 * Load a dongle profile JSON file from profiles/dongles/
 * Returns parsed profile object, or null if not found.
 */
function loadProfile(profileId) {
  const profilePath = path.join(__dirname, '..', 'profiles', 'dongles', `${profileId}.json`);
  try {
    const raw = fs.readFileSync(profilePath, 'utf8');
    const profile = JSON.parse(raw);
    // Build register ranges for bulk reading: group consecutive addresses
    profile.poll_ranges = buildPollRanges(profile.metrics);
    return profile;
  } catch (e) {
    logger.error(`[dongle] Failed to load profile ${profileId}: ${e.message}`);
    return null;
  }
}

/**
 * Group individual metric register addresses into contiguous ranges
 * so we read in bulk (one TCP round-trip per range) instead of one
 * connection per metric.
 *
 * Example: metrics at 0x0065, 0x0066, 0x0068, 0x0069, 0x0100
 *   → ranges: [{ start: 0x0065, count: 2 }, { start: 0x0068, count: 2 }, { start: 0x0100, count: 1 }]
 */
function buildPollRanges(metrics) {
  const addresses = metrics
    .map(m => ({ addr: parseInt(m.register, 16), count: m.count || 1 }))
    .sort((a, b) => a.addr - b.addr);

  const ranges = [];
  for (const item of addresses) {
    const last = ranges[ranges.length - 1];
    // Merge into previous range if address is within 4 registers (allows small gaps)
    if (last && item.addr <= last.start + last.count + 4 && last.start + last.count + 4 >= item.addr) {
      const newEnd = Math.max(last.start + last.count, item.addr + item.count);
      last.count = newEnd - last.start;
    } else {
      ranges.push({ start: item.addr, count: item.count });
    }
  }
  return ranges;
}

/**
 * Poll a single dongle instance (for poll-based transports: V5, Modbus TCP).
 * Reads all register ranges in bulk, maps to named metrics, writes to store.
 */
async function pollInstance(instance, transport, profile) {
  try {
    const registerData = {};
    const now = Date.now();

    for (const range of profile.poll_ranges) {
      const buf = await transport.readRegisters(range.start, range.count);
      for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
        registerData[range.start + i] = buf.readUInt16BE(i * 2);
      }
    }

    const metrics = {};
    const prefix = instance.prefix || '';
    for (const m of profile.metrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;

      // Type conversion
      if (m.type === 'int16') raw = raw > 0x7FFF ? raw - 0x10000 : raw;
      if (m.type === 'uint32') raw = (registerData[addr] << 16) | (registerData[addr + 1] || 0);
      if (m.type === 'int32') {
        raw = (registerData[addr] << 16) | (registerData[addr + 1] || 0);
        if (raw > 0x7FFFFFFF) raw -= 0x100000000;
      }

      const value = parseFloat((raw * (m.scale || 1)).toFixed(4));
      metrics[prefix + m.name] = value;
    }

    writeMetrics(metrics);
    instance.lastSeen = now;
    instance.error = null;
    logger.debug(`[dongle] ${instance.name}: ${Object.keys(metrics).length} metrics in ${Date.now() - now}ms`);

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.error = err.message;
    instance.consecutiveFails = (instance.consecutiveFails || 0) + 1;
    // Back-off: double poll interval after 5 consecutive failures, max 5 minutes
    if (instance.consecutiveFails >= 5) {
      instance.effectiveInterval = Math.min((instance.poll_interval || 30) * Math.pow(2, instance.consecutiveFails - 4), 300);
    }
  }
  // On success, reset back-off
  if (!instance.error) {
    instance.consecutiveFails = 0;
    instance.effectiveInterval = instance.poll_interval || 30;
  }
}

module.exports = { startDonglePolling, restartDonglePolling };
```

---

## 3. Transport Implementations

### 3.1 Solarman V5 Transport

**File:** `modules/dongle/solarmanV5.js`  
**Type:** TCP client  
**Port:** 8899 (default)

#### Frame Structure (request)

```
Offset  Len  Value        Description
0x00    1    0xA5         Start marker
0x01    2    LE uint16    Payload length (after header, before trailer)
0x03    2    0x4510       Control code (request)
0x05    2    LE uint16    Sequence number (random first byte, increments)
0x07    4    LE uint32    Logger serial number
── Payload (15 bytes + Modbus RTU) ──
0x0B    1    0x02         Frame type (inverter)
0x0C    2    0x0000       Sensor type
0x0E    4    0x00000000   Total working time
0x12    4    0x00000000   Power on time
0x16    4    0x00000000   Offset time
0x1A    N    [Modbus RTU] Read request frame (Big-Endian, with CRC)
── Trailer ──
...     1    checksum     XOR sum of bytes 0x01 to end (excl start, checksum, end)
...     1    0x15         End marker
```

#### Implementation

```javascript
// modules/dongle/solarmanV5.js
const net = require('net');
const { buildModbusReadRequest, parseModbusReadResponse, modbusCrc16 } = require('./crc');

class SolarmanV5Transport {
  constructor(instance) {
    this.host = instance.host;
    this.port = instance.port || 8899;
    this.serial = Buffer.alloc(4);
    this.serial.writeUInt32LE(parseInt(instance.serial_number), 0);
    this.unitId = instance.modbus_unit_id || 1;
    this.seqByte = Math.floor(Math.random() * 256); // Random first byte
  }

  /** Read holding registers. Returns Buffer of register data (2 bytes per register). */
  async readRegisters(startAddr, count) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let responseBuffer = Buffer.alloc(0);
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 8000);

      socket.connect(this.port, this.host, () => {
        // Build Modbus RTU read request
        const modbusFrame = buildModbusReadRequest(this.unitId, 3, startAddr, count);
        // Wrap in Solarman V5 frame
        const v5Frame = this._buildV5Frame(modbusFrame);
        socket.write(v5Frame);
      });

      socket.on('data', (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        // Check if we have a complete frame (ends with 0x15)
        if (responseBuffer.length >= 13 && responseBuffer[responseBuffer.length - 1] === 0x15) {
          clearTimeout(timeout);
          socket.destroy();
          try {
            const modbusData = this._parseV5Response(responseBuffer);
            resolve(modbusData);
          } catch (e) { reject(e); }
        }
      });

      socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  /** Build Solarman V5 frame around a Modbus RTU payload */
  _buildV5Frame(modbusRtuFrame) {
    const payloadLen = 15 + modbusRtuFrame.length;
    const buf = Buffer.alloc(11 + payloadLen + 2);
    
    // Header
    buf[0] = 0xA5;                                                     // Start
    buf.writeUInt16LE(payloadLen, 1);                                  // Payload length
    buf.writeUInt16LE(0x4510, 3);                                      // Control code
    buf.writeUInt8(this.seqByte, 5);                                   // Our sequence byte (random, increments)
    buf.writeUInt8(0x00, 6);                                           // Dongle's byte — always 0x00 on request
    this.serial.copy(buf, 7);                                          // Logger serial
    
    // Payload header
    buf[11] = 0x02;                                                    // Frame type (inverter)
    buf.writeUInt16LE(0, 12);                                          // Sensor type
    buf.writeUInt32LE(0, 14);                                          // Working time
    buf.writeUInt32LE(0, 18);                                          // Power on time
    buf.writeUInt32LE(0, 22);                                          // Offset time
    
    // Modbus RTU frame
    modbusRtuFrame.copy(buf, 26);
    
    // Trailer: checksum + end marker
    buf[buf.length - 2] = this._v5Checksum(buf);
    buf[buf.length - 1] = 0x15;
    
    this.seqByte = (this.seqByte + 1) & 0xFF;
    return buf;
  }

  /** Parse Solarman V5 response, extract and validate Modbus RTU payload */
  _parseV5Response(buf) {
    if (buf[0] !== 0xA5) throw new Error('missing start marker');
    if (buf[buf.length - 1] !== 0x15) throw new Error('missing end marker');
    
    // Verify checksum
    const expectedChecksum = this._v5Checksum(buf);
    if (buf[buf.length - 2] !== expectedChecksum) throw new Error('checksum mismatch');
    
    const payloadLen = buf.readUInt16LE(1);
    const controlCode = buf.readUInt16LE(3);
    if (controlCode !== 0x1510) throw new Error(`unexpected control code: 0x${controlCode.toString(16)}`);
    
    // Extract Modbus RTU payload (starts at offset 0x19 = 25 in response, 14 bytes of payload header)
    // Request: 15-byte payload header + Modbus RTU → Modbus RTU starts at 11 + 15 = 26
    // Response: 14-byte payload header + Modbus RTU → Modbus RTU starts at 11 + 14 = 25
    const modbusStart = 25;
    let modbusEnd = 11 + payloadLen;
    let modbusData = buf.slice(modbusStart, modbusEnd);
    
    // Detect and strip Deye double-CRC (two spurious 0x00 bytes appended after valid CRC)
    if (modbusData.length > 5 && modbusData[modbusData.length - 1] === 0x00 && modbusData[modbusData.length - 2] === 0x00) {
      modbusData = modbusData.slice(0, -2);
    }
    
    return parseModbusReadResponse(modbusData);
  }

  _v5Checksum(buf) {
    let sum = 0;
    for (let i = 1; i < buf.length - 2; i++) sum = (sum + buf[i]) & 0xFF;
    return sum;
  }
}

module.exports = { SolarmanV5Transport };
```

#### Key behaviors
- Opens a **new TCP connection per poll** — does not reuse connections (dongles are unstable)
- Sequence number first byte randomized at startup, incremented each request
- Deye double-CRC: checks for two spurious `0x00` bytes before the real CRC and strips them
- 8-second socket timeout per poll attempt

---

### 3.2 Growatt Transport (TCP Server Mode)

**File:** `modules/dongle/growatt.js`  
**Type:** TCP server (push receiver)  
**Port:** 5279 (configurable)

#### Frame Header (8 bytes, Big-Endian)

```
Offset  Len  Description
0x00    2    Transaction ID
0x02    2    Protocol ID (0x0103 = v1.24, 0x0104 = v3.05)
0x04    2    Data length (including 2-byte checksum at end)
0x06    1    Unit ID (device address)
0x07    1    Function code
```

#### Implementation

```javascript
// modules/dongle/growatt.js
const net = require('net');

class GrowattServer {
  constructor(instances, writeFn) {
    this.instances = instances.filter(i => i.transport === 'growatt' && i.enabled);
    this.writeMetrics = writeFn;
    this.port = this.instances[0]?.port || 5279;
    this.server = null;
  }

  start() {
    this.server = net.createServer(socket => {
      const remote = `${socket.remoteAddress}:${socket.remotePort}`;
      logger.info(`[dongle:growatt] connection from ${remote}`);
      
      let buffer = Buffer.alloc(0);
      
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        
        // Growatt frames have a length field at offset 4–5 (Big-Endian uint16)
        // The total frame length = 8-byte header + data_length
        while (buffer.length >= 8) {
          const dataLen = buffer.readUInt16BE(4);
          const totalLen = 8 + dataLen;
          if (buffer.length < totalLen) break; // Incomplete frame
          
          try {
            const frame = buffer.slice(0, totalLen);
            buffer = buffer.slice(totalLen);
            this._processFrame(frame);
          } catch (e) {
            logger.warn(`[dongle:growatt] frame error: ${e.message}`);
            buffer = buffer.slice(1); // Skip one byte, try to re-sync
          }
        }
      });
      
      socket.on('error', err => logger.warn(`[dongle:growatt] socket error: ${err.message}`));
      socket.on('close', () => logger.info(`[dongle:growatt] ${remote} disconnected`));
    });
    
    this.server.listen(this.port, () => {
      logger.info(`[dongle:growatt] listening on :${this.port}`);
    });
  }

  _processFrame(buf) {
    const txId = buf.readUInt16BE(0);
    const protoId = buf.readUInt16BE(2);
    const unitId = buf[6];
    const funcCode = buf[7];
    
    // Only process energy data frames
    if (funcCode !== 0x04) return;
    
    const payload = buf.slice(8, buf.length - 2); // Exclude 2-byte checksum
    const checksum = buf.readUInt16BE(buf.length - 2);
    
    // Verify checksum (sum of all bytes before checksum)
    let sum = 0;
    for (let i = 0; i < buf.length - 2; i++) sum += buf[i];
    if ((sum & 0xFFFF) !== checksum) throw new Error('checksum mismatch');
    
    // Parse based on protocol version
    let data;
    if (protoId === 0x0103) data = this._parseV1_24(payload);
    else if (protoId === 0x0104) data = this._parseV3_05(payload);
    else return; // Unknown protocol — skip silently
    
    // Match to instance by unit ID or serial
    const instance = this.instances.find(i => i.modbus_unit_id === unitId) || this.instances[0];
    if (!instance) return;
    
    const profile = this.profiles[instance.profile];
    if (!profile) return;
    
    // Map parsed data to metrics and write directly to store
    const metrics = this._mapToMetrics(data, profile, instance.prefix || '');
    this.writeMetrics(metrics);
    instance.lastSeen = Date.now();
  }

  /** Parse Growatt v1.24 energy data payload */
  _parseV1_24(payload) {
    let offset = 0;
    const result = {};
    
    // Datalogger serial: 10 ASCII bytes
    result.datalogger_serial = payload.slice(offset, offset + 10).toString('ascii').trim();
    offset += 10;
    
    // Inverter serial: 10 ASCII bytes
    result.inverter_serial = payload.slice(offset, offset + 10).toString('ascii').trim();
    offset += 10;
    
    // Register data: ~90 uint16 values starting at offset 20
    // (Full field map from grottdata.py at grott repo)
    result.pv1_voltage = payload.readUInt16BE(offset) * 0.1;
    result.pv1_current = payload.readUInt16BE(offset + 2) * 0.1;
    result.pv1_power = payload.readUInt16BE(offset + 4) * 0.1;
    result.pv2_voltage = payload.readUInt16BE(offset + 6) * 0.1;
    result.pv2_current = payload.readUInt16BE(offset + 8) * 0.1;
    result.pv2_power = payload.readUInt16BE(offset + 10) * 0.1;
    offset += 12;
    
    result.ac_voltage_r = payload.readUInt16BE(offset) * 0.1;
    result.ac_current_r = payload.readUInt16BE(offset + 2) * 0.1;
    result.ac_power = payload.readUInt16BE(offset + 4) * 0.1;
    result.ac_frequency = payload.readUInt16BE(offset + 6) * 0.01;
    offset += 8;
    
    result.grid_power = payload.readUInt16BE(offset) * 0.1;
    offset += 2;
    
    result.battery_voltage = payload.readUInt16BE(offset) * 0.1;
    offset += 2;
    
    result.inverter_temp = payload.readUInt16BE(offset) * 0.1;
    offset += 2;
    
    // Daily / total energy
    result.daily_solar_kwh = payload.readUInt16BE(offset) * 0.1;
    result.total_solar_kwh = (payload.readUInt16BE(offset + 2) * 65536 + payload.readUInt16BE(offset + 4)) * 0.1;
    
    return result;
  }

  // _parseV3_05 follows same pattern with different offsets — see growatt.py field map

  _mapToMetrics(data, profile, prefix) {
    const metrics = {};
    for (const m of profile.metrics) {
      const val = data[m.field];
      if (val !== undefined && val !== null && !isNaN(val)) {
        metrics[prefix + m.name] = parseFloat((val * (m.scale || 1)).toFixed(4));
      }
    }
    return metrics;
  }

  stop() {
    if (this.server) { this.server.close(); this.server = null; }
  }
}

module.exports = { GrowattServer };
```

#### Dongle reconfiguration (user step)
The user must reconfigure the Growatt dongle via its web UI at `http://<dongle-ip>`:
- Change "Server Address" from `server.growatt.com` to the Epilykos host IP
- Port: 5279
- The dongle will push data every ~5 minutes automatically

---

### 3.3 Plain Modbus TCP Transport

**File:** `modules/dongle/modbusTcp.js`  
**Type:** TCP client (poll-based)  
**Port:** 8899 (Sofar LSE-3), 502 (Voltronic/Axpert)

This is a thin wrapper around the same Modbus RTU frame logic used by the Solarman V5 transport. The difference: no V5 framing — just raw Modbus TCP.

#### Modbus TCP Frame (7-byte MBAP header + Modbus RTU PDU)

```
Offset  Len  Description
0x00    2    Transaction ID
0x02    2    Protocol ID (0x0000 for Modbus)
0x04    2    Length (bytes following, including unit ID)
0x06    1    Unit ID
0x07    N    Modbus PDU (function code + data)
```

#### Implementation

```javascript
// modules/dongle/modbusTcp.js
const net = require('net');

class ModbusTcpTransport {
  constructor(instance) {
    this.host = instance.host;
    this.port = instance.port || 502;
    this.unitId = instance.modbus_unit_id || 1;
    this.txId = 1;
  }

  async readRegisters(startAddr, count) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);

      socket.connect(this.port, this.host, () => {
        // Build Modbus RTU PDU: function 0x03, start addr, register count
        const pdu = Buffer.alloc(5);
        pdu[0] = 0x03;
        pdu.writeUInt16BE(startAddr, 1);
        pdu.writeUInt16BE(count, 3);

        // Wrap in MBAP header
        const frame = Buffer.alloc(7 + pdu.length);
        frame.writeUInt16BE(this.txId++, 0);   // Transaction ID
        frame.writeUInt16BE(0x0000, 2);         // Protocol ID
        frame.writeUInt16BE(pdu.length + 1, 4); // Length (PDU + unit ID)
        frame[6] = this.unitId;                 // Unit ID
        pdu.copy(frame, 7);

        socket.write(frame);
      });

      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        // MBAP header: 7 bytes. Length field at offset 4.
        if (buffer.length >= 7) {
          const pduLen = buffer.readUInt16BE(4) - 1; // Subtract unit ID byte
          const totalLen = 7 + pduLen;
          if (buffer.length >= totalLen) {
            clearTimeout(timeout);
            socket.destroy();
            try {
              const pdu = buffer.slice(8, totalLen); // Skip MBAP + unit ID
              if (pdu[0] & 0x80) { // Exception response
                reject(new Error(`Modbus exception ${pdu[1]}`));
                return;
              }
              // Extract register data: starts at PDU offset 2 (function code byte + byte count)
              const byteCount = pdu[1];
              resolve(pdu.slice(2, 2 + byteCount));
            } catch (e) { reject(e); }
          }
        }
      });

      socket.on('error', err => { clearTimeout(timeout); reject(err); });
    });
  }
}

module.exports = { ModbusTcpTransport };
```

---

### 3.4 Shared CRC Utilities

**File:** `modules/dongle/crc.js`

```javascript
// CRC-16 for Modbus RTU (polynomial 0xA001)
function modbusCrc16(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) crc = (crc >> 1) ^ 0xA001;
      else crc >>= 1;
    }
  }
  return crc;
}

/** Build a Modbus RTU read holding registers frame (with CRC) */
function buildModbusReadRequest(unitId, funcCode, startAddr, count) {
  const buf = Buffer.alloc(8);
  buf[0] = unitId;
  buf[1] = funcCode; // 0x03 = read holding registers
  buf.writeUInt16BE(startAddr, 2);
  buf.writeUInt16BE(count, 4);
  const crc = modbusCrc16(buf.slice(0, 6));
  buf.writeUInt16LE(crc, 6);
  return buf;
}

/** Parse Modbus RTU read response. Returns Buffer of register data (2 bytes per register). */
function parseModbusReadResponse(buf) {
  if (buf.length < 5) throw new Error('response too short');
  if (buf[1] & 0x80) throw new Error(`Modbus exception ${buf[2]}`);
  const byteCount = buf[2];
  if (buf.length < 5 + byteCount) throw new Error('incomplete response');
  
  // Verify CRC
  const expectedCrc = modbusCrc16(buf.slice(0, 3 + byteCount));
  const actualCrc = buf.readUInt16LE(3 + byteCount);
  if (expectedCrc !== actualCrc) throw new Error('CRC mismatch');
  
  return buf.slice(3, 3 + byteCount);
}

module.exports = { modbusCrc16, buildModbusReadRequest, parseModbusReadResponse };
```

---

## 4. Profile JSON Format

**Directory:** `profiles/dongles/`

```json
{
  "name": "SRNE Hybrid Inverter (Solarman V5)",
  "transport": "solarman-v5",
  "requires_serial": true,
  "default_port": 8899,
  "default_unit_id": 1,
  "metrics": [
    {
      "name": "solar_power",
      "register": "0x0065",
      "count": 1,
      "type": "uint16",
      "scale": 0.1,
      "unit": "W"
    },
    {
      "name": "solar_voltage",
      "register": "0x006D",
      "count": 1,
      "type": "uint16",
      "scale": 0.1,
      "unit": "V"
    },
    {
      "name": "battery_soc",
      "register": "0x0100",
      "count": 1,
      "type": "uint16",
      "scale": 0.1,
      "unit": "%"
    },
    {
      "name": "battery_power",
      "register": "0x0101",
      "count": 1,
      "type": "int16",
      "scale": 0.1,
      "unit": "W"
    },
    {
      "name": "grid_power",
      "register": "0x006B",
      "count": 1,
      "type": "int16",
      "scale": 0.1,
      "unit": "W"
    },
    {
      "name": "load_power",
      "register": "0x0070",
      "count": 1,
      "type": "uint16",
      "scale": 0.1,
      "unit": "W"
    },
    {
      "name": "inverter_temperature",
      "register": "0x0074",
      "count": 1,
      "type": "uint16",
      "scale": 0.1,
      "unit": "°C"
    }
  ]
}
```

**Field reference:**
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Profile display name |
| `transport` | string | `solarman-v5`, `growatt`, or `modbus-tcp` |
| `requires_serial` | bool | Whether serial number field is required in settings |
| `default_port` | int | Pre-filled port in settings |
| `default_unit_id` | int | Modbus unit/slave ID |
| `metrics` | array | Register map entries |
| `metrics[].name` | string | Metric name written to store |
| `metrics[].register` | string | Hex register address |
| `metrics[].type` | string | `uint16`, `int16`, `uint32`, `int32` |
| `metrics[].scale` | float | Multiply raw register value by this |
| `metrics[].unit` | string | Display hint (not used by backend, for UI) |

---

## 5. Backend Integration

### 5.1 Database

No schema changes. Add config key to essentials:

```javascript
// modules/database.js — in essentialKeys array
'dongle_config',

// Default value (in initializeDatabase defaults)
'dongle_config': '[]',
```

### 5.2 server.js

```javascript
const { startDonglePolling, restartDonglePolling } = require('./modules/dongle');

// After other polling setup:
startDonglePolling();

// In POST /api/settings handler, add to the restart triggers:
if ('dongle_config' in updates) restartDonglePolling();
```

### 5.3 API Routes

```javascript
// List available profiles
app.get('/api/dongle/profiles', isAuthenticated, (req, res) => {
  const profilesDir = path.join(__dirname, 'profiles', 'dongles');
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
  const profiles = files.map(f => {
    const raw = JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf8'));
    return { id: f.replace('.json', ''), name: raw.name, transport: raw.transport, requires_serial: raw.requires_serial, default_port: raw.default_port };
  });
  res.json(profiles);
});

// Test connection to a dongle
app.post('/api/dongle/test', isAuthenticated, async (req, res) => {
  const { host, port, serial_number, profile, transport } = req.body;
  try {
    const profileData = loadProfile(profile);
    let transportObj;
    if (transport === 'solarman-v5') transportObj = new SolarmanV5Transport({ host, port, serial_number, modbus_unit_id: 1 });
    else transportObj = new ModbusTcpTransport({ host, port, modbus_unit_id: 1 });

    // Read one register as a test (battery SOC at 0x0100 for most inverters)
    const data = await transportObj.readRegisters(0x0100, 1);
    res.json({ success: true, raw: data.readUInt16BE(0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

---

## 6. Settings UI

**Location:** New sub-tab in Data Sources: "Inverter Dongles"

**Card layout per instance:**

```
┌─ [Instance Name] ──────────────────────────────── [× Remove] ─┐
│  Name:     [________________]                                   │
│  Enabled:  [✓]                                                  │
│  Profile:  [SRNE Hybrid Inverter (Solarman V5) ▼]              │
│  Transport:[solarman-v5 ▼]          (auto-filled from profile)  │
│  Host:     [192.168.1.55]                                       │
│  Port:     [8899]                   (auto-filled from profile)  │
│  Serial #: [2308012345]             (hidden if not required)    │
│  Unit ID:  [1]                                                   │
│  Poll:     [30] seconds                                          │
│  Prefix:   [inverter1_]             (optional)                   │
│                                                                  │
│  [Test Connection]  status: OK — 24 metrics in 0.3s             │
└──────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Profile dropdown populated from `GET /api/dongle/profiles`
- Selecting a profile auto-fills transport, port, and shows/hides serial number
- "Test Connection" calls `POST /api/dongle/test`
- Save persists to `dongle_config` key via existing form submit handler

---

## 7. Error Handling & Resilience

| Scenario | Behavior |
|----------|----------|
| Connection refused | Log warning, skip this poll, retry on next cycle |
| Timeout (8s V5, 5s Modbus) | Destroy socket, log, retry next cycle |
| CRC mismatch | Discard response, log warning |
| Modbus exception code | Log exception code, skip metrics for this cycle |
| Partial frame (no end marker) | Wait for more data, timeout after 8s |
| 5 consecutive failures | Double poll interval (max 5 min), reset on success |
| Deye double-CRC | Detected and stripped silently |
| Growatt connection drop | TCP server auto-reconnects on next push |

---

## 8. Implementation Order

### Phase 1 — Core Solarman V5 (2–3 days)
- [ ] `modules/dongle/crc.js` — CRC-16, Modbus frame builder/parser
- [ ] `modules/dongle/solarmanV5.js` — TCP client transport
- [ ] `modules/dongle.js` — polling loop, metric mapping, start/stop
- [ ] `profiles/dongles/srne-hybrid.json` — first profile
- [ ] `server.js` integration + `dongle_config` key
- [ ] Basic settings UI (no test button yet)

### Phase 2 — Modbus TCP + Profiles (1–2 days)
- [ ] `modules/dongle/modbusTcp.js` — plain Modbus TCP transport
- [ ] `profiles/dongles/sofar-lse3.json`
- [ ] `profiles/dongles/voltronic-axpert.json`
- [ ] `profiles/dongles/deye-hybrid.json`
- [ ] `POST /api/dongle/test` + settings Test button
- [ ] `GET /api/dongle/profiles` + profile dropdown

### Phase 3 — Growatt Server (1–2 days)
- [ ] `modules/dongle/growatt.js` — TCP server, frame parser
- [ ] `profiles/dongles/growatt-spf.json`
- [ ] Settings UI: note about dongle reconfiguration
- [ ] Multi-instance support (match by unit ID/serial)

### Phase 4 — Polish (1 day)
- [ ] Back-off on consecutive failures
- [ ] `GET /api/dongle/status` — per-instance live status
- [ ] README.md update
