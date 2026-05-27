# Epilykos — Inverter Dongle Data Source: Technical Implementation Plan

**Project:** Epilykos Energy Monitoring Dashboard  
**Feature:** `dongle` data source module — local LAN polling of inverter WiFi dongles  
**Target branch:** `feature/dongle-source`  
**Document status:** Draft v1.0

---

## Table of Contents

1. [Overview & Goals](#1-overview--goals)
2. [Architecture Decision](#2-architecture-decision)
3. [File & Directory Structure](#3-file--directory-structure)
4. [Protocol Specifications](#4-protocol-specifications)
   - 4.1 Solarman V5 (SRNE, Deye, Sofar LSW-3, most Chinese OEM)
   - 4.2 Growatt ShineWiFi (port 5279)
   - 4.3 Plain Modbus RTU over TCP (Sofar LSE-3, some Voltronic)
5. [Dongle Profile JSON Specification](#5-dongle-profile-json-specification)
6. [Backend Module: `modules/dongle.js`](#6-backend-module-modulesdonglejss)
   - 6.1 Module contract
   - 6.2 Transport layer classes
   - 6.3 Polling loop
   - 6.4 Metric normalisation
   - 6.5 Error handling & reconnection
7. [Database Schema Changes](#7-database-schema-changes)
8. [Settings API Routes](#8-settings-api-routes)
9. [Settings UI Changes](#9-settings-ui-changes)
10. [server.js Integration](#10-serverjs-integration)
11. [Cloud Blocking Guidance](#11-cloud-blocking-guidance)
12. [Docker & Dependency Changes](#12-docker--dependency-changes)
13. [Implementation Phases](#13-implementation-phases)
14. [Testing Checklist](#14-testing-checklist)
15. [Reference Sources](#15-reference-sources)

---

## 1. Overview & Goals

Many power inverters (SRNE, Deye, Growatt, Sofar, Voltronic/Axpert, etc.) ship with WiFi
"stick logger" dongles that relay inverter data to vendor cloud servers in China. These dongles
simultaneously expose a local LAN TCP port that accepts the same framing protocol the cloud
uses — meaning they can be polled directly, locally, without any cloud dependency.

This feature adds `dongle` as a first-class data source in Epilykos, following the same
module contract as `ha.js`, `mqtt.js`, `modbus.js`, and `external.js`. It:

- Polls the dongle's LAN TCP port on a configurable interval
- Decodes inverter registers via a JSON profile (same pattern as `profiles/` for Modbus)
- Writes normalised named metrics into the central metrics store
- Optionally continues to allow cloud uploads (transparent) or blocks them
- Requires no hardware changes — the dongle stays plugged into the inverter

### Out of scope for this feature

- Firmware replacement (ESPHome/Tasmota flashing) — a separate advanced guide
- Proxy/MITM server mode — the module polls actively; passive sniffing is not included
- Writing inverter register values (read-only initially)

---

## 2. Architecture Decision

### Why a separate module and not an extension of `modbus.js`

`modbus.js` speaks Modbus TCP or Modbus RTU over serial. Dongles use vendor-specific framing
*around* a Modbus RTU payload (Solarman V5, Growatt custom), or in some cases expose plain
Modbus TCP on a non-standard port. The dongle module handles:

- Multiple transport protocols (V5, Growatt, plain Modbus TCP)
- Logger serial number authentication (required by Solarman V5)
- Reconnect behaviour specific to these embedded devices (they are unstable)
- Cloud-blocking configuration and diagnostics

The `dongle` module internally re-uses CRC and Modbus frame construction logic. It does NOT
depend on the `modbus-serial` npm package — both the Solarman V5 and Growatt transports are
implemented using Node.js's built-in `net` module only, to avoid native addon compilation
issues in Docker (which we have already had to resolve with `sqlite3`).

### Transport classification

| Dongle family                    | Protocol layer | Local port | Serial # needed |
|----------------------------------|---------------|------------|----------------|
| Solarman LSW-3 / LSE-3 (WiFi)   | Solarman V5   | 8899       | Yes            |
| SRNE WiFi stick (Solarman OEM)   | Solarman V5   | 8899       | Yes            |
| Deye / SunSynk WiFi stick        | Solarman V5   | 8899       | Yes            |
| Sofar LSW-3 (WiFi, older fw)     | Solarman V5   | 8899       | Yes            |
| Sofar LSE-3 (LAN stick)          | Plain Modbus TCP | 8899    | No             |
| Growatt ShineWiFi-S/X/T          | Growatt v1/v3 | 5279       | No             |
| Growatt ShineWiFi-X2 (newer)     | Growatt MQTT  | 7006       | No (out of scope v1) |
| Voltronic / Axpert (some models) | Plain Modbus TCP | 502     | No             |

---

## 3. File & Directory Structure

```
epilykos/
├── modules/
│   ├── dongle.js                   ← NEW: main dongle module
│   └── dongle/
│       ├── solarmanV5.js           ← NEW: Solarman V5 transport class
│       ├── growatt.js              ← NEW: Growatt ShineWiFi transport class
│       ├── modbusTcp.js            ← NEW: plain Modbus TCP transport (thin wrapper)
│       └── crc.js                  ← NEW: shared CRC-16 and Modbus CRC utilities
├── profiles/
│   └── dongles/                    ← NEW directory
│       ├── srne-hybrid.json        ← SRNE hybrid inverter register map
│       ├── deye-hybrid.json        ← Deye/SunSynk hybrid
│       ├── growatt-hybrid.json     ← Growatt SPH/SPA hybrid
│       ├── sofar-ktlx.json         ← Sofar K-TLX G2/G3
│       └── voltronic-axpert.json   ← Axpert / PIP series
└── public/
    ├── settings.html               ← ADD: Dongle section
    └── settings.js                 ← ADD: Dongle section handlers
```

---

## 4. Protocol Specifications

### 4.1 Solarman V5 Protocol

**Used by:** SRNE, Deye, SunSynk, Sofar LSW-3, most IGEN-Tech OEM dongles  
**Port:** `tcp/8899`  
**Endianness:** Header fields Little-Endian; Modbus RTU payload Big-Endian (per Modbus spec)  
**Auth:** Logger serial number (4 bytes) embedded in every frame header

#### Request Frame Layout

```
Offset  Size  Value         Description
──────────────────────────────────────────────────────────────────
0x00    1     0xA5          Frame start marker
0x01    2     LE uint16     Payload length (bytes after header, before trailer)
0x03    2     0x4510        Control code for Modbus RTU request
0x05    2     LE uint16     Sequence number (first byte random, increments)
0x07    4     LE uint32     Logger serial number
── Payload starts here ──────────────────────────────────────────
0x0B    1     0x02          Frame type (0x02 = solar inverter target)
0x0C    2     0x0000        Sensor type
0x0E    4     0x00000000    Total working time (zero on request)
0x12    4     0x00000000    Power on time (zero on request)
0x16    4     0x00000000    Offset time (zero on request)
0x1A    N     [Modbus RTU]  Modbus RTU frame (Big-Endian, includes CRC)
── Trailer ──────────────────────────────────────────────────────
0x1A+N  1     checksum      XOR/sum of all bytes from 0x01 to (0x1A+N-1)
0x1B+N  1     0x15          Frame end marker
```

#### Response Frame Layout

```
Offset  Size  Value         Description
──────────────────────────────────────────────────────────────────
0x00    1     0xA5          Frame start
0x01    2     LE uint16     Payload length
0x03    2     0x1510        Control code for Modbus RTU response
0x05    2     LE uint16     Sequence number echo
0x07    4     LE uint32     Logger serial number
── Payload ──────────────────────────────────────────────────────
0x0B    1     0x02          Frame type
0x0C    1     0x01          Status (0x01 = real-time data)
0x0D    4     LE uint32     Total working time (seconds, since manufacture)
0x11    4     LE uint32     Power on time (seconds, current uptime)
0x15    4     LE uint32     Offset time
0x19    N     [Modbus RTU]  Modbus RTU response frame
── Trailer ──────────────────────────────────────────────────────
      1     checksum
      1     0x15
```

#### Checksum Calculation

```js
// Solarman V5 checksum: sum of all payload bytes modulo 256
// (excludes start byte 0xA5, the checksum byte itself, and end byte 0x15)
function v5Checksum(buf) {
  let sum = 0;
  for (let i = 1; i < buf.length - 2; i++) {
    sum = (sum + buf[i]) & 0xFF;
  }
  return sum;
}
```

#### Key behaviour notes

- The dongle continues reporting to Solarman Cloud while also serving local requests on port 8899.
  Local polling does NOT disrupt cloud uploads.
- Some Deye inverters append a spurious double CRC (two extra `0x00` bytes) to the Modbus RTU
  frame inside the response. The parser must detect and strip these.
- The sequence number's first byte should be randomised at startup and incremented per request.
  The dongle echoes the first byte back; mismatches indicate stale responses from a previous poll.
- If the connection drops mid-poll, close the socket and reconnect on the next interval.
  Do not re-use a half-open TCP connection.

**Reference implementations:**
- https://github.com/jmccrohan/pysolarmanv5 (Python, canonical reference)
- https://pysolarmanv5.readthedocs.io/en/stable/solarmanv5_protocol.html (full spec)
- https://github.com/XtheOne/Inverter-Data-Logger/issues/3#issuecomment-878911661 (original RE)
- https://github.com/danzelziggy/srne-solarman (SRNE-specific HACS integration)
- https://github.com/MichaluxPL/Sofar_LSW3 (Sofar LSW-3 via V5)

---

### 4.2 Growatt ShineWiFi Protocol

**Used by:** Growatt ShineWiFi-S, ShineWiFi-X, ShineWiFi-T  
**Port:** `tcp/5279`  
**Endianness:** Big-Endian (MSB-first / network byte order)  
**Auth:** None (no serial number required)

The Growatt protocol wraps data logger identity and inverter energy data in a proprietary 8-byte
header, similar in spirit to Modbus TCP but with a different framing ontology.

#### Frame Header (8 bytes, Big-Endian)

```
Offset  Size  Description
──────────────────────────────────────────
0x00    2     Transaction identifier (sequence number)
0x02    2     Protocol identifier (Growatt-specific, NOT 0x0000 like Modbus)
0x04    2     Data length (bytes following this header, including 2-byte checksum)
0x06    1     Unit identifier (device address on bus)
0x07    1     Function code
```

#### Protocol identifiers (field at 0x02)

```
0x0002  — Configuration / announce messages
0x0103  — Energy data payload (v1.20 / v1.24 protocol)
0x0104  — Energy data payload (v3.05 protocol, newer inverters)
```

#### Data payload

The payload structure depends on the function code and protocol version. For energy data
(function code 0x04, protocol 0x0103), the payload contains:

- Datalogger serial (10 bytes ASCII)
- Inverter serial (10 bytes ASCII)
- ~90 uint16 register values covering: PV voltage/current/power, AC voltage/frequency/power,
  grid import/export, battery, temperature, daily/total kWh

The full Growatt v1.24 register map is documented in:
- https://www.vromans.org/johan/software/sw_growatt_wifi_protocol.html
- https://github.com/johanmeijer/grott (see `grottdata.py` for field offsets)

#### Proxy mode vs active poll mode

Unlike Solarman V5, the Growatt protocol does not support local polling — the dongle *pushes*
data to the configured server every 5 minutes. To receive data, Epilykos must either:

**Option A (Proxy mode — recommended):** Re-configure the dongle's target server (via its
web UI at `http://<dongle-ip>`) to point at the Epilykos host on port 5279. Epilykos listens
as a TCP server, decodes incoming frames, publishes metrics, and optionally forwards the
original frame to `server.growatt.com:5279`.

**Option B (DNS redirect):** Point `server.growatt.com` to the Epilykos host in your local
DNS (dnsmasq override). The dongle connects thinking it's the Growatt server.

This makes the Growatt transport architecturally different from V5: it is a **TCP server**
that receives push data rather than a **TCP client** that polls.

**Reference implementations:**
- https://github.com/johanmeijer/grott (canonical, Python)
- https://www.ietfng.org/nwf/misc/growatt-protocol.html (detailed protocol RE)
- https://github.com/knowthelist/Growatt-server (Perl standalone server)
- https://github.com/OpenInverterGateway/OpenInverterGateway (ESP firmware replacement)

---

### 4.3 Plain Modbus TCP

**Used by:** Sofar LSE-3 (LAN stick), some Voltronic/Axpert models  
**Port:** `tcp/8899` (Sofar), `tcp/502` (standard Modbus)  
**Auth:** None  
**Endianness:** Big-Endian (Modbus spec)

These devices expose a standard Modbus TCP server. The `modules/dongle/modbusTcp.js` transport
is a thin wrapper: open socket → send Modbus TCP frame → receive response → extract register
values. This is functionally identical to `modbus.js` TCP mode and can share the Modbus frame
construction code.

Sofar LSE-3 note: the LSE-3 handles Modbus TCP natively on port 8899 and is reliable for
concurrent clients. The WiFi LSW-3 also exposes 8899 but is single-client and less stable.

**Reference:**
- https://homeassistant-solax-modbus.readthedocs.io/en/latest/sofar-installation/
- https://github.com/wills106/homeassistant-solax-modbus

---

## 5. Dongle Profile JSON Specification

Profiles live in `profiles/dongles/<name>.json`. They declare the transport protocol and
the register map — which addresses to read, how to scale them, and what metric names to
use in Epilykos.

### Schema

```json
{
  "id": "srne-hybrid",
  "name": "SRNE Hybrid Inverter (Solarman V5)",
  "transport": "solarman-v5",
  "port": 8899,
  "requires_serial": true,
  "modbus_unit_id": 1,
  "poll_registers": [
    {
      "start": "0x0100",
      "count": 20,
      "function": 3
    },
    {
      "start": "0x0200",
      "count": 10,
      "function": 3
    }
  ],
  "metrics": [
    {
      "name": "solar_power",
      "register": "0x00BA",
      "type": "uint16",
      "scale": 1,
      "unit": "W",
      "description": "PV input power"
    },
    {
      "name": "solar_voltage",
      "register": "0x00B8",
      "type": "uint16",
      "scale": 0.1,
      "unit": "V"
    },
    {
      "name": "battery_soc",
      "register": "0x0100",
      "type": "uint16",
      "scale": 1,
      "unit": "%"
    },
    {
      "name": "battery_voltage",
      "register": "0x0101",
      "type": "uint16",
      "scale": 0.1,
      "unit": "V"
    },
    {
      "name": "battery_power",
      "register": "0x00BF",
      "type": "int16",
      "scale": 1,
      "unit": "W",
      "description": "Positive = charging, negative = discharging"
    },
    {
      "name": "grid_power",
      "register": "0x0212",
      "type": "int16",
      "scale": 1,
      "unit": "W",
      "description": "Positive = import, negative = export"
    },
    {
      "name": "load_power",
      "register": "0x00B7",
      "type": "uint16",
      "scale": 1,
      "unit": "W"
    },
    {
      "name": "inverter_temperature",
      "register": "0x00C4",
      "type": "int16",
      "scale": 0.1,
      "unit": "°C"
    },
    {
      "name": "daily_solar_kwh",
      "register": "0x006C",
      "type": "uint16",
      "scale": 0.1,
      "unit": "kWh"
    },
    {
      "name": "total_solar_kwh",
      "register": "0x006E",
      "type": "uint32",
      "scale": 0.1,
      "unit": "kWh",
      "description": "32-bit value spanning registers 0x006E and 0x006F"
    }
  ]
}
```

### Schema field reference

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique profile identifier (matches filename) |
| `name` | string | Human-readable name shown in settings UI |
| `transport` | enum | `"solarman-v5"` \| `"growatt"` \| `"modbus-tcp"` |
| `port` | int | Default TCP port (overridable per instance) |
| `requires_serial` | bool | Whether a logger serial number is needed (V5 only) |
| `modbus_unit_id` | int | Modbus slave address (usually 1) |
| `poll_registers` | array | Register ranges to read in each poll cycle |
| `poll_registers[].start` | hex string | Start register address |
| `poll_registers[].count` | int | Number of registers to read in one request |
| `poll_registers[].function` | int | Modbus function code (3 = holding, 4 = input) |
| `metrics[]` | array | Individual metric definitions |
| `metrics[].name` | string | Metric name in Epilykos (e.g. `solar_power`) |
| `metrics[].register` | hex string | Register address |
| `metrics[].type` | enum | `"uint16"` \| `"int16"` \| `"uint32"` \| `"int32"` |
| `metrics[].scale` | float | Multiply raw register value by this (e.g. 0.1 for deciUnits) |
| `metrics[].unit` | string | Display unit |
| `metrics[].description` | string | Optional notes |

### Initial profiles to ship

| Profile file | Transport | Covers |
|---|---|---|
| `srne-hybrid.json` | solarman-v5 | SRNE ML/MLT/HESP hybrid series |
| `deye-hybrid.json` | solarman-v5 | Deye SUN-xK-SG04LP3, SunSynk |
| `sofar-ktlx-lsw3.json` | solarman-v5 | Sofar K-TLX via LSW-3 WiFi stick |
| `sofar-ktlx-lse3.json` | modbus-tcp | Sofar K-TLX via LSE-3 LAN stick |
| `growatt-hybrid.json` | growatt | Growatt SPH/MID hybrid series |
| `voltronic-axpert.json` | modbus-tcp | Axpert / PIP series (port 502) |

**Register map sources:**
- SRNE: SRNE official Modbus protocol document (request from support / community copies on DIY Solar Forum)
- Deye: https://github.com/kellerza/sunsynk (register map in `sunsynk/definitions/`)
- Sofar: https://github.com/wills106/homeassistant-solax-modbus (sofar definitions)
- Growatt: https://www.vromans.org/johan/software/sw_growatt_wifi_protocol.html
- Voltronic/Axpert: https://github.com/ned-kelly/docker-voltronic-homeassistant

---

## 6. Backend Module: `modules/dongle.js`

### 6.1 Module Contract

The module exports an object matching the pattern of all other Epilykos data source modules:

```js
// modules/dongle.js
module.exports = {
  start(db, metricsStore, logger),   // initialise from DB config, begin polling
  stop(),                            // stop all polling, close all connections
  getStatus(),                       // return array of instance status objects
};
```

`start()` is called once from `server.js` during initialisation, exactly as `ha.js`,
`mqtt.js`, and `modbus.js` are called today.

### 6.2 Transport Layer Classes

Each transport lives in `modules/dongle/<transport>.js` and implements the same interface:

```js
class SolarmanV5Transport {
  constructor({ host, port, serialNumber, unitId }) {}

  // Read a contiguous range of holding registers.
  // Returns Buffer of raw register bytes (Big-Endian uint16 pairs).
  async readRegisters(startAddress, count) {}

  // Close TCP socket cleanly.
  async close() {}
}
```

#### `modules/dongle/solarmanV5.js` — implementation sketch

```js
const net = require('net');
const { buildModbusReadRequest, parseModbusReadResponse } = require('./crc');

class SolarmanV5Transport {
  constructor({ host, port = 8899, serialNumber, unitId = 1 }) {
    this.host = host;
    this.port = port;
    this.serialNumber = parseInt(serialNumber, 10); // stored as uint32 LE
    this.unitId = unitId;
    this._seq = Math.floor(Math.random() * 0xFF); // random initial sequence byte
  }

  async readRegisters(startAddress, count) {
    // 1. Build Modbus RTU read-holding-registers request (FC 03)
    const modbusFrame = buildModbusReadRequest(this.unitId, 0x03, startAddress, count);

    // 2. Wrap in Solarman V5 frame
    const v5Frame = this._buildV5Frame(modbusFrame);

    // 3. Open TCP connection, send frame, await response
    const response = await this._sendAndReceive(v5Frame);

    // 4. Unwrap V5 frame, extract Modbus RTU response payload
    const modbusResponse = this._unwrapV5Response(response);

    // 5. Parse Modbus response, return register data buffer
    return parseModbusReadResponse(modbusResponse);
  }

  _buildV5Frame(modbusRtuFrame) {
    const payloadLength = 15 + modbusRtuFrame.length;
    const frame = Buffer.alloc(11 + payloadLength + 2);
    let offset = 0;

    // Header
    frame.writeUInt8(0xA5, offset++);                             // Start
    frame.writeUInt16LE(payloadLength, offset); offset += 2;      // Length
    frame.writeUInt16LE(0x4510, offset); offset += 2;             // Control code (request)
    frame.writeUInt8(this._seq & 0xFF, offset++);                 // Seq byte 1
    frame.writeUInt8(0x00, offset++);                             // Seq byte 2
    frame.writeUInt32LE(this.serialNumber, offset); offset += 4;  // Logger serial

    // Payload
    frame.writeUInt8(0x02, offset++);                             // Frame type
    frame.writeUInt16LE(0x0000, offset); offset += 2;             // Sensor type
    frame.writeUInt32LE(0x00000000, offset); offset += 4;         // Total working time
    frame.writeUInt32LE(0x00000000, offset); offset += 4;         // Power on time
    frame.writeUInt32LE(0x00000000, offset); offset += 4;         // Offset time
    modbusRtuFrame.copy(frame, offset); offset += modbusRtuFrame.length;

    // Trailer
    const checksum = v5Checksum(frame.slice(0, offset));
    frame.writeUInt8(checksum, offset++);
    frame.writeUInt8(0x15, offset++);

    this._seq = (this._seq + 1) & 0xFF;
    return frame;
  }

  _unwrapV5Response(buf) {
    // Validate start/end markers
    if (buf[0] !== 0xA5 || buf[buf.length - 1] !== 0x15) {
      throw new Error('Invalid V5 response frame markers');
    }
    // Modbus RTU frame starts at offset 0x19 (25)
    // Payload ends at buf.length - 2 (before checksum and end byte)
    let modbusEnd = buf.length - 2;
    // Handle Deye double-CRC bug: strip trailing 0x0000
    if (buf[modbusEnd - 2] === 0x00 && buf[modbusEnd - 1] === 0x00) {
      modbusEnd -= 2;
    }
    return buf.slice(25, modbusEnd);
  }

  _sendAndReceive(frame) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = 10000;
      let data = Buffer.alloc(0);

      socket.setTimeout(timeout);

      socket.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        // V5 response: check for end marker 0x15 at expected position
        if (data.length > 10 && data[data.length - 1] === 0x15) {
          socket.destroy();
          resolve(data);
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`Solarman V5 socket timeout after ${timeout}ms`));
      });

      socket.on('error', reject);

      socket.connect(this.port, this.host, () => {
        socket.write(frame);
      });
    });
  }
}
```

#### `modules/dongle/growatt.js` — TCP server (push-based)

The Growatt transport inverts the client/server relationship. Instead of `readRegisters()`,
`GrowattTransport` starts a TCP server and calls back into `dongle.js` when a data frame
arrives.

```js
class GrowattTransport extends EventEmitter {
  constructor({ listenPort = 5279, forwardHost = null, forwardPort = 5279 }) {}

  // Start the TCP server. Emits 'data' event with parsed register map.
  start() {}

  // Stop the TCP server.
  stop() {}
}
```

The `dongle.js` module subscribes to the `'data'` event and writes incoming metrics
immediately to the store — no polling interval is set for Growatt instances (data arrives
at the dongle's push cadence, typically every 5 minutes).

#### `modules/dongle/crc.js` — shared utilities

```js
// Modbus CRC-16 (polynomial 0xA001)
function modbusCrc16(buf) { ... }

// Build a Modbus RTU read request frame (with CRC)
function buildModbusReadRequest(unitId, fc, startAddr, count) { ... }

// Parse Modbus RTU read response, return register data as Buffer
// Throws on exception code or CRC mismatch
function parseModbusReadResponse(buf) { ... }
```

### 6.3 Polling Loop

For poll-based transports (Solarman V5, plain Modbus TCP), `dongle.js` runs a setInterval
loop per configured dongle instance:

```js
async function pollInstance(instance, transport, profile, metricsStore, logger) {
  try {
    // Collect all register ranges needed for this profile's metrics
    const registerData = {};

    for (const range of profile.poll_registers) {
      const start = parseInt(range.start, 16);
      const buf = await transport.readRegisters(start, range.count);
      // Store raw uint16 values keyed by register address
      for (let i = 0; i < range.count; i++) {
        registerData[start + i] = buf.readUInt16BE(i * 2);
      }
    }

    // Map raw register values to named metrics
    const metrics = {};
    for (const m of profile.metrics) {
      const addr = parseInt(m.register, 16);
      let raw = registerData[addr];
      if (raw === undefined) continue;

      if (m.type === 'int16') raw = raw > 0x7FFF ? raw - 0x10000 : raw;
      if (m.type === 'uint32') raw = (raw << 16) | registerData[addr + 1];
      if (m.type === 'int32') {
        raw = (raw << 16) | registerData[addr + 1];
        if (raw > 0x7FFFFFFF) raw -= 0x100000000;
      }

      // Apply metric name prefix if instance has one configured
      const key = instance.prefix
        ? `${instance.prefix}_${m.name}`
        : m.name;

      metrics[key] = parseFloat((raw * m.scale).toFixed(4));
    }

    metricsStore.update(metrics);
    instance.lastSeen = Date.now();
    instance.error = null;

  } catch (err) {
    logger.warn(`[dongle] ${instance.name}: poll failed — ${err.message}`);
    instance.error = err.message;
  }
}
```

### 6.4 Metric Normalisation

Metrics written to the store use the same naming convention as all other modules.
Standard metric names to use across all dongle profiles for compatibility with
existing Epilykos blocks:

| Metric name | Description |
|---|---|
| `solar_power` | PV input power (W) |
| `solar_voltage` | PV voltage (V) |
| `solar_current` | PV current (A) |
| `battery_soc` | Battery state of charge (%) |
| `battery_voltage` | Battery voltage (V) |
| `battery_power` | Battery power, + charge / − discharge (W) |
| `battery_current` | Battery current (A) |
| `battery_temperature` | Battery temperature (°C) |
| `grid_power` | Grid power, + import / − export (W) |
| `grid_voltage` | Grid voltage (V) |
| `grid_frequency` | Grid frequency (Hz) |
| `load_power` | Load / consumption (W) |
| `inverter_temperature` | Inverter heatsink temperature (°C) |
| `daily_solar_kwh` | Solar yield today (kWh) |
| `total_solar_kwh` | Total solar yield all-time (kWh) |
| `daily_charge_kwh` | Battery charged today (kWh) |
| `daily_discharge_kwh` | Battery discharged today (kWh) |
| `daily_grid_import_kwh` | Grid imported today (kWh) |
| `daily_grid_export_kwh` | Grid exported today (kWh) |

Multiple dongle instances are distinguished by a user-configurable prefix (e.g. `site2_`),
consistent with how HA and MQTT multi-device instances work.

### 6.5 Error Handling & Reconnection

- **Connection refused / timeout:** Log warning, mark instance as `error`, retry on next poll cycle. Do not crash.
- **Partial frames:** If the response buffer does not end with `0x15` (V5) within the timeout window, discard and retry.
- **Modbus exception codes:** Log the exception code with a human-readable description. Do not write metrics for that poll cycle.
- **Deye double-CRC:** Detect and strip silently (see `_unwrapV5Response`).
- **Back-off:** If 5 consecutive polls fail, double the poll interval up to a maximum of 5 minutes, then reset on success.

---

## 7. Database Schema Changes

The existing pattern stores all data source config as JSON in the `settings` table.

Add a new key: `dongle_config` storing an array of dongle instance objects.

```sql
-- No schema migration needed; settings table stores arbitrary JSON keys.
-- New key:
INSERT OR IGNORE INTO settings (key, value) VALUES ('dongle_config', '[]');
```

### Dongle instance config structure

```json
[
  {
    "id": "dongle_1",
    "name": "SRNE Hybrid",
    "enabled": true,
    "profile": "srne-hybrid",
    "transport": "solarman-v5",
    "host": "192.168.1.55",
    "port": 8899,
    "serial_number": "2308012345",
    "modbus_unit_id": 1,
    "poll_interval_seconds": 30,
    "prefix": "",
    "metric_mappings": {
      "solar_power": "solar_power",
      "battery_soc": "battery_soc"
    }
  }
]
```

`metric_mappings` is optional — if absent, the profile's default metric names are used.
If present, the user can remap profile metric names to custom Epilykos metric names.

---

## 8. Settings API Routes

Add to `server.js` (or a new router `modules/dongle-routes.js`):

```
GET  /api/dongle/profiles          List available profiles from profiles/dongles/
GET  /api/dongle/config            Return current dongle_config from DB
POST /api/dongle/config            Save dongle_config to DB, restart dongle module
GET  /api/dongle/status            Return per-instance status (lastSeen, error, metricCount)
POST /api/dongle/test              Test connectivity to a dongle (single poll, return result)
```

### `GET /api/dongle/profiles`

Returns array of profile metadata (id, name, transport, requires_serial) from all
`profiles/dongles/*.json` files. The UI uses this to populate the profile dropdown.

### `POST /api/dongle/test`

Body: `{ host, port, serial_number, profile }`.
Performs a single poll attempt and returns either the raw metric values or an error object.
Useful for the settings UI "Test Connection" button.

---

## 9. Settings UI Changes

### New section in `settings.html`

Add a "Inverter Dongles" section tab alongside existing Home Assistant, MQTT, Modbus tabs.

#### Section layout

```
┌─ Inverter Dongles ───────────────────────────────────────────────────────┐
│                                                                           │
│  [+ Add Dongle]                                                           │
│                                                                           │
│  ┌─ SRNE Hybrid ─────────────────────────────────────────── [×] ──────┐  │
│  │ Profile:         [SRNE Hybrid Inverter (Solarman V5)    ▼]          │  │
│  │ Dongle IP:       [192.168.1.55           ]                          │  │
│  │ Port:            [8899    ]                                         │  │
│  │ Logger Serial:   [2308012345    ] (printed on dongle label)         │  │
│  │ Poll interval:   [30] seconds                                       │  │
│  │ Metric prefix:   [         ] (optional, e.g. "site2")               │  │
│  │                                                                     │  │
│  │  [Test Connection]    Last seen: 12s ago  ✓ 14 metrics              │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  [Save Dongle Settings]                                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

#### `settings.js` additions

```js
// Load profiles and populate dropdown
async function loadDongleProfiles() {
  const res = await fetch('/api/dongle/profiles');
  const profiles = await res.json();
  // populate <select id="dongle-profile-X"> elements
}

// Toggle visibility of "Logger Serial" field based on profile.requires_serial
function onProfileChange(profileId, instanceEl) {
  const profile = profiles.find(p => p.id === profileId);
  instanceEl.querySelector('.serial-field').hidden = !profile.requires_serial;
  instanceEl.querySelector('.port-field').value = profile.port;
}

// Test connection
async function testDongleConnection(instanceId) {
  const config = getDongleInstanceConfig(instanceId);
  const res = await fetch('/api/dongle/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  const result = await res.json();
  showTestResult(instanceId, result);
}
```

---

## 10. `server.js` Integration

Following the pattern of all other modules:

```js
// server.js — add alongside existing module initialisations

const dongle = require('./modules/dongle');

// In the async startup function, after DB init:
await dongle.start(db, metricsStore, logger);

// In the graceful shutdown handler:
await dongle.stop();
```

The `/api/dongle/*` routes can be registered in a new file:

```js
const dongleRouter = require('./modules/dongle-routes');
app.use('/api/dongle', sessionAuth.requireAuth, dongleRouter);
```

---

## 11. Cloud Blocking Guidance

The settings UI should include a collapsible "Cloud Blocking" section with guided steps.
This does not require any code — it is documentation rendered in the UI. Content:

### For all dongle types: DNS override (dnsmasq)

The user has dnsmasq already running. Add an override for the vendor cloud hostname:

```
# /etc/dnsmasq.d/inverter-block.conf

# Solarman / IGEN-Tech (SRNE, Deye, Sofar LSW-3)
address=/iot.solarmanpv.com/0.0.0.0
address=/globalapi.solarmanpv.com/0.0.0.0

# Growatt
address=/server.growatt.com/0.0.0.0
address=/server-us.growatt.com/0.0.0.0
```

Using `0.0.0.0` drops the connection. Using the Epilykos host IP instead routes it to
Epilykos for proxy mode (Growatt only).

### iptables hard block (belt-and-suspenders)

Use the dongle's static LAN IP to block all outbound traffic except to Epilykos:

```bash
# Drop all outbound traffic from the dongle EXCEPT to the Epilykos server
DONGLE_IP="192.168.1.55"
LOCAL_SERVER="192.168.1.100"

iptables -I FORWARD -s $DONGLE_IP ! -d $LOCAL_SERVER -j DROP
iptables -I FORWARD -s $DONGLE_IP -d $LOCAL_SERVER -j ACCEPT
```

Make persistent with `iptables-persistent` / `netfilter-persistent save`.

### Assign the dongle a static IP

Without a static IP, the DNS/iptables rules break after a DHCP lease renewal. Set a static
DHCP lease in the router by MAC address, or configure it via the dongle's web UI at
`http://<dongle-ip>` → "STA Interface Setting".

---

## 12. Docker & Dependency Changes

### No new npm dependencies

Both the Solarman V5 and Growatt transports use only Node.js built-ins (`net`, `events`,
`Buffer`). No new packages are needed. The `modbus-tcp` transport can optionally use
`modbus-serial` which is already in `package.json`.

### `package.json` — no changes required

### `Dockerfile` — no changes required

The dongle module does not require native compilation (unlike `sqlite3` and `better-sqlite3`
which needed the multi-stage build fix). All code is pure JavaScript.

### `profiles/dongles/` directory

Must be included in the Docker image. Verify it is not excluded by `.dockerignore`:

```
# .dockerignore — ensure this line is NOT present:
# profiles/
```

If the COPY instruction in the Dockerfile is selective, add:

```dockerfile
COPY profiles/ ./profiles/
```

---

## 13. Implementation Phases

### Phase 1 — Core Solarman V5 (2–3 days)

- `modules/dongle/crc.js` — CRC-16, Modbus frame builder/parser
- `modules/dongle/solarmanV5.js` — TCP client transport
- `modules/dongle.js` — polling loop, metric normalisation, start/stop
- `profiles/dongles/srne-hybrid.json` — first profile
- API route: `GET /api/dongle/profiles`, `GET/POST /api/dongle/config`
- `server.js` integration
- Basic settings UI section (no Test button yet)

**Validation:** Point at SRNE dongle at `192.168.1.x:8899`, confirm metrics appear in
the dashboard metrics store within one poll cycle.

### Phase 2 — Additional Profiles & Test Endpoint (1–2 days)

- `profiles/dongles/deye-hybrid.json`
- `profiles/dongles/sofar-ktlx-lsw3.json`
- `profiles/dongles/sofar-ktlx-lse3.json`
- `modules/dongle/modbusTcp.js` — plain Modbus TCP transport
- API route: `POST /api/dongle/test`
- Settings UI: Test Connection button, profile dropdown dynamic fields,
  serial number field show/hide

### Phase 3 — Growatt Push Server (1–2 days)

- `modules/dongle/growatt.js` — TCP server mode, frame parser
- `profiles/dongles/growatt-hybrid.json`
- Settings UI: note that Growatt requires dongle re-configuration, show instructions
- Cloud blocking guidance section in UI

### Phase 4 — Hardening & Polish (1 day)

- Back-off on consecutive failures
- `GET /api/dongle/status` — per-instance live status for settings UI
- Deye double-CRC detection (already in V5 parser, needs test)
- Growatt forward-to-cloud option (relay mode)
- README.md update — Inverter Dongles section

---

## 14. Testing Checklist

### Unit tests (offline, no hardware)

- [ ] `crc.js`: Modbus CRC-16 produces correct checksum for known frames
- [ ] `solarmanV5.js`: Frame builder produces correct byte sequence for known inputs
- [ ] `solarmanV5.js`: Response parser correctly extracts Modbus payload
- [ ] `solarmanV5.js`: Deye double-CRC is detected and stripped
- [ ] `dongle.js`: uint16/int16/uint32 sign extension and scaling are correct

### Integration tests (with hardware or mock server)

- [ ] Live poll of SRNE dongle returns expected solar_power, battery_soc, grid_power
- [ ] Poll survives dongle reboot (reconnects on next cycle)
- [ ] Multiple instances with different prefixes write to separate metric keys
- [ ] Growatt transport receives a pushed data frame correctly

### Settings UI tests

- [ ] Profile dropdown populates from `/api/dongle/profiles`
- [ ] Serial number field hides/shows based on `requires_serial`
- [ ] Port pre-fills based on selected profile
- [ ] Test Connection returns human-readable result
- [ ] Save persists config and restarts module without restarting Express

### Docker tests

- [ ] `profiles/dongles/` directory is present inside container
- [ ] Module starts cleanly with empty `dongle_config` (no configured instances)
- [ ] Module starts cleanly with one configured instance

---

## 15. Reference Sources

### Protocol documentation

| Source | URL |
|---|---|
| Solarman V5 protocol spec (canonical) | https://pysolarmanv5.readthedocs.io/en/stable/solarmanv5_protocol.html |
| Solarman V5 original RE thread | https://github.com/XtheOne/Inverter-Data-Logger/issues/3#issuecomment-878911661 |
| Growatt WiFi protocol (vromans) | https://www.vromans.org/johan/software/sw_growatt_wifi_protocol.html |
| Growatt protocol RE (nwf) | https://www.ietfng.org/nwf/misc/growatt-protocol.html |
| Sofar LSW-3/LSE-3 installation guide | https://homeassistant-solax-modbus.readthedocs.io/en/latest/sofar-installation/ |

### Reference implementations

| Project | Language | URL |
|---|---|---|
| pysolarmanv5 | Python | https://github.com/jmccrohan/pysolarmanv5 |
| grott (Growatt proxy) | Python | https://github.com/johanmeijer/grott |
| Grottserver (Growatt cloud replacement) | Python | https://github.com/johanmeijer/grott/wiki/Grottserver |
| srne-solarman (HACS) | Python | https://github.com/danzelziggy/srne-solarman |
| Sofar LSW3 reader | Python | https://github.com/MichaluxPL/Sofar_LSW3 |
| OpenInverterGateway (ESP firmware) | C++ | https://github.com/OpenInverterGateway/OpenInverterGateway |
| knowthelist Growatt server | Perl | https://github.com/knowthelist/Growatt-server |

### Register maps

| Inverter | Source |
|---|---|
| Deye / SunSynk hybrid | https://github.com/kellerza/sunsynk (definitions/) |
| SRNE hybrid | DIY Solar Forum + SRNE iPower app RE |
| Sofar K-TLX | https://github.com/wills106/homeassistant-solax-modbus |
| Growatt SPH/MID | https://github.com/johanmeijer/grott (grottdata.py) |
| Voltronic / Axpert | https://github.com/ned-kelly/docker-voltronic-homeassistant |

### Community resources

| Resource | URL |
|---|---|
| DIY Solar Forum — SRNE Modbus thread | https://diysolarforum.com/threads/has-anyone-tried-to-use-srne-modbus-communication-protocol.81780/ |
| Sofar Elektroda thread (registers) | https://www.elektroda.com/rtvforum/topic3698233.html |
| splitbrain.org — Growatt + HA deep dive | https://www.splitbrain.org/blog/2023-11/03-growatt_and_home_assistant |
| openHAB Solarman binding | https://www.openhab.org/addons/bindings/solarman/ |
