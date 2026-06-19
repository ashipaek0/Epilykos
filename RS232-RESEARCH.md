# RS232 Inverter Data Source — Deep Research

> Research conducted for adding raw serial (RS232) inverter support to Epilykos,
> an open-source Node.js/Express/SQLite solar energy dashboard.
> Current version: v2.7.0

---

## 1. Inverter Protocol Landscape (RS232)

Unlike Modbus RTU (which Epilykos already supports), each inverter brand implements
its own proprietary protocol over RS232. Below is a per-brand analysis.

### 1.1 SMA (Sunny Boy / Sunny Island)

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (DE-9, 3-wire: TX/RX/GND), also RS485 piggyback |
| **Defaults** | 9600 baud, 8N1 (some older: 19200) |
| **Protocol** | SMA **Speedwire** (proprietary packet format) or **SMA Data Manager** protocol |
| **Data format** | Binary frames with CRC16, frame structure: `[start 0xAA][length][type][payload][CRC]` |
| **Comm pattern** | Poll/response — master sends query frame, slave replies |
| **State** | Streaming possible in some models (interval reports) |
| **Known libs** | `smasync` (Python), `sma-webbox` (Python), `sbfspot` (C++ for Sunny Boy), `sma-inverter` (Node.js) |
| **Tricky bits** | Multiple device IDs; Speedwire packet reassembly; some newer units only do Speedwire over Ethernet |
| **Metrics available** | AC power, DC power, daily yield, total yield, grid voltage, frequency, inverter temp |

**sbfspot** (the reference open-source SMA tool) reverse-engineered the Sunny Boy protocol
completely. Its protocol encoding is well-documented: query packets use SMA NET Piggy-Back
protocol with 4-byte header + variable payload + CRC16. Responses come in 0x10-byte chunks
that must be reassembled.

### 1.2 Victron Energy (VE.Direct / VE.Bus)

| Aspect | Detail |
|--------|--------|
| **Transport** | VE.Direct (3.5mm jack, TTL-level serial at 3.3V — requires USB adapter or level shifter) |
| **Defaults** | 19200 baud, 8N1, no flow control |
| **Protocol** | **VE.Direct text protocol** (ASCII, newline-delimited key-value pairs) — widely documented |
| **Data format** | `KEY\tVALUE\n` — one key-value pair per line, terminated by a checksum line |
| **Comm pattern** | **Streaming** — the inverter pushes data continuously at ~1s intervals (no query needed) |
| **Known libs** | `vedirect` (Python), `vedirect-serial` (Node.js — `node-red-contrib-victron`, `vedirect` npm), `velib_python` |
| **Tricky bits** | Checksum is XOR of all bytes; some models send hex-encoded blocks; VE.Bus uses binary instead of text |
| **Metrics available** | Battery voltage, battery current, battery SOC, panel power, panel voltage, load, temperature, daily/yield totals |

**VE.Direct Protocol Details:**
- Each message block starts with a `PID` (Product ID) label, ends with `Checksum` label
- Labels and values separated by tab (`\t`)
- Frame boundary detected by the `Checksum` line
- Labels include: `V` (battery voltage), `I` (battery current), `VPV` (panel voltage), `PPV` (panel power), `SOC`, `T` (temperature), `H1`-`H23` (history data), `HSDS` (day sequence number), `MPPT` (tracker mode)
- For VE.Bus (Quattro/MultiPlus): Binary protocol, frames with length byte, device ID, command byte, checksum

**VE.Bus Binary Protocol:**
- Frame: `[length][device_id][command][...data...][checksum]`
- Checksum = XOR of all bytes to make sum = 0
- Commands: `0x01` (keep alive), `0x02` (data request), `0x03` (response)
- Temperature/current are sent as signed 16-bit with fixed-point scaling

### 1.3 Fronius

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (older models like IG/IG Plus), newer all Ethernet |
| **Defaults** | 9600 baud, 8N1 |
| **Protocol** | **Fronius Interface RS232 Protocol** — ASCII query/response |
| **Data format** | ASCII text, pipe-delimited or space-delimited fields |
| **Comm pattern** | Query/response — send command string, receive response |
| **Known libs** | `fronius-to-influx` (Python), `fronius-inverter` (npm), `pyfronius` |
| **Metrics** | AC power, daily energy, total energy, grid voltage, grid frequency, inverter temp |

**Fronius protocol notes:**
- Commands are like `GET DEVICE STATUS` or `GET POWER`
- Response uses fixed field positions separated by `|`
- Some models use a simple ASCII protocol where every line starts with a 2-char command ID
- Older **Fronius IG** uses a binary frame format with start byte `0x02`, length, payload, checksum

### 1.4 Goodwe

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (older), RS485 (newer), WiFi dongle (Ethernet) |
| **Defaults** | 9600 baud, 8N1 |
| **Protocol** | Proprietary **Goodwe protocol** — binary with CRC16 |
| **Data format** | Binary frame: `[0xAA][0x55][length][cmd][payload...][CRC16]` |
| **Comm pattern** | Query/response |
| **Known libs** | `goodwe` (Python — very complete), `goodwe-inverter` (npm — minimal) |
| **Tricky bits** | WiFi dongle models need to be polled via UDP/TCP to port 8899 (Solarman V5 protocol); pure RS232 models are rarer |
| **Metrics** | PV power, PV voltage, battery SOC/power/voltage, grid power, load power, temperature |

The Python `goodwe` library is the gold standard — it supports 100+ Goodwe models over
Modbus RTU, Modbus TCP, and the proprietary protocol. The raw RS232 variant uses the
same register semantics as Modbus but wrapped in Goodwe's own frame format.

### 1.5 Deye / SolArk

| Aspect | Detail |
|--------|--------|
| **Transport** | RS485 (primary), RS232 (older), WiFi dongle (Solarman V5 TCP) |
| **Defaults** | 9600 baud, 8N1 |
| **Protocol** | Deye uses **Modbus RTU** over RS485 — **NOT raw RS232** most of the time |
| **Data format** | Standard Modbus RTU frames (already supported by Epilykos Modbus module) |
| **Comm pattern** | Query/response |
| **Known libs** | Epilykos already has a Deye Modbus profile! |
| **Note** | RS232 models are extremely rare for Deye; almost all are RS485/Modbus. The existing Epilykos Modbus data source with RS485 transport setting handles these. No separate RS232 module needed for Deye. |

### 1.6 Growatt

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232, RS485, WiFi dongle (Growatt Shine WiFi/X) |
| **Defaults** | 9600 baud, 8N1 |
| **Protocol** | **Growatt serial protocol** — ASCII or binary depending on model |
| **Data format** | Frames start with `#` or `(` for ASCII; binary uses `0x3A` start byte |
| **Comm pattern** | Query/response (send `#` + device ID + command, get response) |
| **Known libs** | `growatt` (Python), `growatt-rs232` (Python), `growatt-inverter` (npm) |
| **Tricky bits** | Device ID is significant; some models require a login/auth sequence; different firmware versions speak different protocols |
| **Metrics** | PV power, battery power, grid power, load, daily yield, total yield, temperature |

**Growatt ASCII protocol example:**
- Query: `#001\r` (poll device 001)
- Response: `(001 5000 220 50 100 2500 12.5 45.2 300 ...)\r`
- Fields are space-separated: device ID, PV power, grid voltage, frequency, battery SOC, battery power, battery voltage, temperature, load power, etc.

Some newer Growatt models use a binary protocol with CRC8/CRC16.

### 1.7 SolarEdge (RS232 models)

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (some older SE models; most use Ethernet/RS485 for Modbus) |
| **Defaults** | 115200 baud, 8N1 (some: 9600) |
| **Protocol** | **SolarEdge proprietary** — binary framed protocol |
| **Data format** | Binary frames with header, payload, CRC |
| **Comm pattern** | Query/response + some unsolicited status messages |
| **Known libs** | `solaredge` (Python), `solaredge-modbus` (npm — Modbus TCP only) |
| **Tricky bits** | Most SolarEdge inverters expose Modbus TCP over Ethernet; the old RS232 protocol is rare and poorly documented |
| **Metrics** | Solar power, grid power, battery power, consumption, voltage, daily energy |

SolarEdge's primary interface is **Modbus TCP over Ethernet** (SunSpec compliant).
The RS232 protocol was used only on early SE models (SE3000-SE6000) and is essentially
a serial version of the SunSpec register map. If someone needs raw RS232 SolarEdge,
a custom binary parser is needed — but for 95% of users, the existing Modbus TCP path
works.

### 1.8 Huawei (SUN2000)

| Aspect | Detail |
|--------|--------|
| **Transport** | RS485 (Modbus RTU), Ethernet (Modbus TCP) — NOT raw RS232 |
| **Defaults** | 9600 baud, 8N1 (RS485), 9600 or 19200 |
| **Protocol** | **Modbus RTU** — standard, already supported by Epilykos |
| **Known libs** | Huawei provides Modbus register map; `huawei-solar` (Python) |
| **Note** | No raw RS232 protocol exists for Huawei. The inverter communicates exclusively via Modbus. The existing Epilykos Modbus data source handles this. |

## 1.8 Phocos

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (DB9), also RS485 on newer AnyGrid models |
| **Defaults** | 2400 baud, 8N1 (older); 9600 baud (newer) |
| **Protocol** | **Voltronic QPIGS/QPGS ASCII protocol** — identical to Voltronic/Axpert |
| **Data format** | ASCII, space-delimited fields, CRC checksum, `\r` terminated |
| **Comm pattern** | Query/response — send `QPIGS`, `QPGS{n}`, `QID`, get space-delimited response |
| **Known libs** | `wolffshots/phocus` (Go), `python-phocos` (Python) |
| **Confirmation** | The Go `phocus` library at github.com/wolffshots/phocus implements QPIGS, QPGSn, QID commands identically to Voltronic. Same CRC, same response format, same fault codes. This proves Phocos is Voltronic-compatible. |
| **Metrics** | AC I/O V/Hz, battery V/SOC/current, PV V/current, charging current, load VA/W, inverter temp, fault codes, operation mode, parallel/3-phase info |
| **RS232 viable?** | ✅ **YES** — same QPIGS profile as Voltronic |

**Conclusion:** Phocos uses the same Voltronic QPIGS ASCII protocol over RS232. A single profile handles both brands.

## 1.9 SolaX

| Aspect | Detail |
|--------|--------|
| **Transport** | RS485 (primary), USB-to-TTL (Pocket USB), WiFi dongle |
| **Defaults** | 9600 baud, 8N1 |
| **Protocol** | **SolaX Pocket USB protocol** — binary, `AA 55` framing |
| **Data format** | Binary frame: `[AA 55][size][ctrl][func][payload...][chk_lo chk_hi]` |
| **Comm pattern** | Query/response — register dongle → request serial → request data |
| **Known libs** | `aiosolax-uart` (Python — github.com/jesserockz/aiosolax-uart), `xdubx/Solax-Pocket-USB-reverse-engineering`, `solax_x1_inverter_serial_comms` (Python) |
| **Frame size** | Min 7 bytes, max 255 bytes |
| **Checksum** | 16-bit little-endian additive checksum over all preceding bytes |
| **Functions** | `0x01`=Query, `0x02`=Register; Functions: `0x01`=Register dongle, `0x05`=Request serial, `0x0C`=Request data |
| **Metrics available** | Grid V/A/W/Hz, PV1 V/A/W, PV2 V/A/W, battery V/W/SOC/SOH/temp, battery max V and charge/discharge currents, EPS V/A/W/Hz, import/export power, self-consumption, total energy, today energy, inverter temp, runtime, operating mode, RTC clock |
| **RS232 viable?** | ✅ **YES** — over USB-to-TTL adapter at 9600 8N1. Requires binary JS decoder. |

**SolaX model families:**
- X1 Grid-Tie (Mini, Air, Boost, Smart) — no battery
- X1 Hybrid (G3/G4.1+) — adds battery + EPS
- X3 Grid-Tie (Mega, Mic, Pro) — three-phase
- X3 Hybrid (G2/G4.2+) — three-phase with battery

## 1.10 SRNE

Already fully supported by Epilykos Modbus module:
- `profiles/SRNE Inverter v.1.96.json` (19 registers)
- `profiles/srne-all-in-one.json` (more comprehensive)
- Also has Solarman V5 WiFi dongle (planned in `dongle` module)
- **RS232 module NOT needed** — use Modbus serial transport option

## 1.11 Felicity

Already fully supported by Epilykos Modbus module:
- `profiles/Felicity IVEM6048-II.json` — 68 registers covering PV, battery, inverter, generator, smart load, BMS
- Uses Modbus RTU over RS485
- **RS232 module NOT needed** — use Modbus serial transport option

## 1.12 MUST / MPPSolar

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (DB9), RS485, USB |
| **Defaults** | 2400 baud, 8N1 (common) |
| **Protocol** | **Voltronic QPIGS ASCII protocol** — MUST/MPPSolar are Voltronic clones |
| **Data format** | ASCII, space-delimited fields, CRC checksum |
| **Comm pattern** | Query/response |
| **RS232 viable?** | ✅ **YES** — same QPIGS profile as Voltronic |

**Conclusion:** MUST/MPPSolar are cloned Voltronic designs. They use identical QPIGS, QPGSn, QID, and other Voltronic commands. A single profile covers Voltronic, Phocos, MUST, MPPSolar, and potentially Sako.

## 1.13 Sako

Likely a Voltronic clone (common Chinese OEM). No specific protocol repos on GitHub, but Sako inverters sold in Africa/South America typically use the same Voltronic QPIGS ASCII protocol.
- **Assumed RS232 viability:** ✅ **YES** — expected QPIGS protocol
- **Fallback:** Modbus RTU via RS485 if not QPIGS-compatible

## 1.14 Schneider Electric (Conext / XW Pro)

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (DB9 on older Conext/XW), RS485, Ethernet |
| **Defaults** | 9600-19200 baud, 8N1 |
| **Protocol** | **Modbus RTU over RS232** — uses standard Modbus registers |
| **RS232 viable?** | ⚠️ Already supported by Epilykos Modbus module via serial transport option |

### 1.14 Solis (Ginlong Technologies)

| Aspect | Detail |
|--------|--------|
| **Transport** | RS485 (native), WiFi/Ethernet dongle (S3 DLS) |
| **Defaults** | 9600 baud, 8N1 (RS485); port 502 (Modbus TCP via dongle) |
| **Protocol** | **Modbus RTU over RS485** — standard Modbus, already supported by Epilykos |
| **Data format** | Standard Modbus RTU frames |
| **Comm pattern** | Query/response |
| **Known libs** | `solis_modbus` (HA HACS, 130⭐), `hn/ginlong-solis` (ESPHome, 157⭐), `solis2mqtt`, `ha_solis_modbus` |
| **Register maps** | ✅ Well-documented: string inverters (2xxx/3xxx/36xxx), hybrid (33xxx/34xxx/43xxx/90xxx) — [solis-modbus.readthedocs.io](https://solis-modbus.readthedocs.io/en/latest/sensors.html) |
| **Metrics available** | PV power/voltage/current, battery SOC/power/voltage/temperature, grid power/voltage/frequency, load power, daily/total energy, inverter temp, charge/discharge control |
| **OEM** | **Ginlong Technologies** — independent manufacturer, not a Voltronic clone |
| **RS232 viable?** | ❌ No raw RS232 — but full Modbus RTU over RS485, already handled by Epilykos Modbus module (select RS485 serial transport) |

### 1.15 Infinisolar

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (DB9), RS485 (via Modbus II card) |
| **Defaults** | 2400 baud, 8N1 |
| **Protocol** | **Voltronic QPIGS ASCII protocol** — Infinisolar is a Voltronic/Axpert rebadge |
| **Data format** | ASCII `(`-prefixed, space-delimited fields |
| **Comm pattern** | Query/response — identical to Voltronic |
| **OEM** | ✅ **Confirmed Voltronic rebadge** — same family as Axpert, Mppsolar, MPI, EASUN, WESTECH, Voltacon |
| **RS232 viable?** | ✅ **Already covered** by Voltronic QPIGS profile — no new profile needed |

### 1.16 Luxpower (LuxpowerTek)

| Aspect | Detail |
|--------|--------|
| **Transport** | RS485 (native), WiFi/Ethernet dongle (WL-Link on port 8000) |
| **Defaults** | 9600 baud, 8N1 (RS485); port 8000 (TCP via dongle) |
| **Protocol** | **Modbus RTU over RS485** (standard) — already handled by Epilykos Modbus module |
| **Dongle protocol** | **Custom TCP wrapper** on port 8000 — not standard Modbus TCP. Custom 18-byte header with `0xa1 0x1a` prefix wrapping standard Modbus function codes (0x03 Read Holding, 0x04 Read Input, 0x06 Write Single, 0x10 Write Multi) |
| **Known libs** | `lxp-bridge` (Rust, 39⭐), `pylxpweb` (Python, 15⭐), `eg4-bridge` (Rust fork, 22⭐), HA integrations (68⭐ each), ESPHome configs |
| **Register maps** | ✅ Well-documented: [lxp-bridge Wiki](https://github.com/celsworth/lxp-bridge/wiki/Inverter-Basics) + [TCP Packet Spec](https://github.com/celsworth/lxp-bridge/wiki/TCP-Packet-Spec). Input registers: addresses 0-274. Holding registers. Battery pack data starts at IR 5000. |
| **OEM** | **EG4 Electronics** — EG4 18kPV, 12000XP, GridBOSS, FlexBOSS are rebadged Luxpower with white-label cert |
| **RS232 viable?** | ❌ No raw RS232 — uses Modbus RTU over RS485 (already handled by Modbus module). Custom TCP dongle protocol could be a future addition for the dongle module, not RS232 module. |

### 1.17 Alpsolar

| Aspect | Detail |
|--------|--------|
| **Transport** | WiFi (cloud), no local serial |
| **Protocol** | **Cloud API only** via Inteless/E-Linter platform — no local RS232/RS485/Modbus access |
| **OEM** | Inteless/E-Linter rebadge |
| **Known libs** | 1 recent HA custom integration (cloud-based, April 2026) |
| **RS232 viable?** | ❌ No — cloud-only protocol. Requires API reverse engineering, not suitable for RS232 module. |

### 1.18 Lvtopsun

| Aspect | Detail |
|--------|--------|
| **What they make** | **Lithium battery ESS** (battery racks), NOT inverters |
| **Models** | LVTS-512314-G4 (51.2V, 10.24kWh), LVTS-512200-G3, LVTS-512300-G3 |
| **Protocol** | Standard BMS protocols (CAN/RS485, Pylontech-compatible) |
| **RS232 viable?** | ❌ Not an inverter manufacturer. Batteries can be monitored via BMS protocols (separate scope). |

### 1.19 Haisic

| Aspect | Detail |
|--------|--------|
| **Website** | `haisic.com` — **does not resolve** |
| **Protocol** | **Unknown** — no public documentation, no community projects, zero GitHub/HA/ESPHome presence |
| **RS232 viable?** | ❌ No public info available. Requires hardware-in-hand reverse engineering. |

### 1.20 SMK

| Aspect | Detail |
|--------|--------|
| **Website** | `smkplc.com` — **does not resolve**. SMK Corporation (Japan) makes connectors/switches. |
| **Protocol** | **Unknown** — no evidence of SMK-branded solar inverters with documented protocols |
| **RS232 viable?** | ❌ No public info available. Likely not an inverter manufacturer. |

### 1.21 Summary: Protocol Classification for New Brands

| Brand | Protocol Type | Local Access | Epilykos Integration | Effort |
|-------|-------------|-------------|---------------------|--------|
| **Solis** | Modbus RTU over RS485 | ✅ Yes | Use existing Modbus module with serial transport | None |
| **Infinisolar** | Voltronic QPIGS ASCII | ✅ Yes | Already covered by RS232 Voltronic profile | None |
| **Luxpower** | Modbus RTU + custom TCP dongle | ✅ Yes (Modbus) / ⚠️ (custom TCP) | Modbus via existing module; custom TCP dongle → future dongle module | Low (TCP) |
| **Alpsolar** | Cloud API (Inteless) | ❌ No local | Not suitable for RS232 module | High |
| **Lvtopsun** | N/A (battery brand) | N/A | Not applicable | N/A |
| **Haisic** | Unknown | ❌ No info | Not viable without reverse engineering | Very High |
| **SMK** | Unknown | ❌ No info | Not viable without reverse engineering | Very High |

**Will be included in v1 RS232 module**: **Voltronic QPIGS** (Voltronic/Axpert/Phocos/MUST/MPPSolar/Sako/Infinisolar), **Victron VE.Direct** (streaming), and **SolaX Pocket USB** (binary AA55).

**Already covered by existing Modbus module**: **Felicity**, **SRNE**, **Deye/SolArk**, **Growatt**, **Schneider**, **Huawei**, **SolarEdge**, **Solis**, **Luxpower** (RS485) — all have Modbus RTU profiles or use Modbus over RS485.

|
**Already covered by existing Modbus module**: **Felicity**, **SRNE**, **Deye/SolArk**, **Growatt**, **Schneider**, **Huawei**, **SolarEdge** — all have Modbus RTU profiles or use Modbus over RS485.

| Aspect | Detail |
|--------|--------|
| **Transport** | RS232 (DE-9), USB (onboard USB-to-serial), Bluetooth |
| **Defaults** | 2400 baud (older) or 9600 baud (newer), 8N1 |
| **Protocol** | **Voltronic/Axpert QPIGS protocol** — well-documented ASCII |
| **Data format** | ASCII query/response, response is comma-separated values after a `(` prefix |
| **Comm pattern** | Query/response — send `QPIGS\n`, get response with `(` prefix |
| **Known libs** | `piapprox` (Python), `voltronic-inverter` (Python), `axpert-monitor` (Node.js), `node-axpert` (npm) |
| **Tricky bits** | 2400 baud is very slow (~3s per poll); some clones use different baud rates; requires a specific wake-up sequence on some units |
| **Metrics** | Grid voltage/frequency, PV voltage/power, battery voltage/SOC/current, load power, inverter temp, daily yield |

**Standard QPIGS command:**
- Query: `QPIGS\r\n` (or `QPIGS` + CRC for newer protocol)
- Response: `(000.0 230.1 50.00 000.0 00.00 000.0 00.0 000.0 025.1 0013 0000 0.00 00000 00000 00000 00000 00 00 00 00.0\r\n`
- Fields in order: grid voltage, grid frequency, AC output voltage, AC output frequency, load VA, load W, battery voltage, battery charging current, battery capacity, inverter heat sink temp, PV input current, PV input voltage, battery voltage from SCC, battery discharge current, flags (mode, fault codes)

There's also `QPIRI` (device info), `QMOD` (mode status), `QFLAG` (flag status), `QPIWS` (warnings/status).

The Voltronic protocol is one of the best candidates for initial RS232 support because:
1. It's simple ASCII, easy to parse
2. Extremely well documented by the open-source community
3. Works with many clone brands (MPP Solar, PowMr, EASun, Sungoldpower, Upower, etc.)
4. Common in off-grid / hybrid setups (also sold as "Axpert" or "PIP" series)

### 1.10 Other Brands of Interest

| Brand | Protocol | Format | Notes |
|-------|----------|--------|-------|
| **ABB / Power-One** | PVI-COMM (RS232) | ASCII query/response | Older models; `aures` family |
| **Schneider Electric (XW/Conext)** | RS232 with Modbus wrapper | ASCII+Binary | Modbus RTU over RS232 |
| **Outback Power** | Mate3 / OpticsRE serial | ASCII tabular | Proprietary ASCII protocol |
| **Samil Power / Solar River** | Modbus RTU | Binary | Actually Modbus, supported |
| **Sofar Solar** | Modbus RTU over RS485 | Binary | Already in dongle profiles |
| **SRNE** | Modbus RTU | Binary | Already in dongle profiles |
| **EASun Power** | Clones Voltronic/Axpert | ASCII | Covered by Voltronic parser |
| **Mastervolt** | MasterBus serial | Binary | Proprietary, uses MVG protocol |

---

## 2. Protocol Classification

### 2.1 ASCII vs Binary

| Type | Brands | Pros | Cons |
|------|--------|------|------|
| **ASCII (text)** | Victron VE.Direct, Voltronic/Axpert/QPIGS, Infinisolar (Voltronic clone), Growatt (some), Fronius (some), Outback | Human-readable, easy to debug, simple to parse, cross-platform | Slower per frame, more bytes on wire |
|| **Binary** | SMA Speedwire, Goodwe, SolarEdge (old), VE.Bus, Fronius IG SolaX AA55 | Compact, faster, lower overhead | Harder to debug, need CRC validation, endianness matters |
|| **Modbus RTU** (over RS485) | Solis, Luxpower (RS485), Deye, Growatt (modbus), Felicity, SRNE, Huawei, Schneider | Standardized, already supported by Epilykos, many libs | Requires RS485 adapter, not raw RS232 |
| **Hybrid** | Growatt (newer), Fronius (newer) | Variable | Depends on model |

### 2.2 Query/Response vs Streaming

| Pattern | Brands | Implication |
|---------|--------|-------------|
| **Query/Response** (poll) | SMA, Fronius (most), Goodwe, Growatt, Voltronic/Axpert, Infinisolar, SolaX, SolarEdge, Solis, Luxpower | Each poll cycle: open serial, send query, read response, close. Simple, matches Epilykos 30s poll pattern. Most Modbus RTU brands also follow this pattern via existing Modbus module. |
| **Streaming** (push) | Victron VE.Direct | Inverter continuously sends data every ~1s. Need to keep port open and accumulate data. Must detect frame boundaries. |
| **Hybrid** | SMA (some models send periodic updates), Fronius (live data mode) | Can support both, but query/response is simpler to integrate. |

### 2.3 Frame Detection Strategies

| Protocol | Frame Start | Frame End | Validation |
|----------|------------|-----------|------------|
| Victron VE.Direct | Any line after checksum | `Checksum\tNN` line | XOR of all bytes |
| Voltronic QPIGS | `(` character | `\r\n` | Fixed field count |
| Infinisolar | `(` character | `\r\n` | Fixed field count (same as Voltronic) |
| Growatt ASCII | `(` or `#` | `\r\n` or `)` | Device ID match |
| SMA Speedwire | `0xAA` byte | After CRC check | CRC16 |
| Goodwe binary | `0xAA 0x55` | After payload + CRC | CRC16 |
| SolaX AA55 | `0xAA 0x55` `[size]` | After additive checksum | 16-bit additive checksum |
| Fronius ASCII | Command-specific | `\r\n` or `\n` | Field parsing |
| VE.Bus binary | Length byte | After checksum byte | XOR checksum |
| Modbus RTU (Solis, Luxpower, etc.) | 0x00-0xF7 slave addr | After CRC16 validation | CRC16 (handled by Modbus module) |

---

## 3. Generic Parser Framework vs. Per-Profile Parsers

### 3.1 Options Analysis

**Option A: Generic framework (recommended)**

A core parser engine that handles the RS232 transport layer (open/close/read/write/timeout)
and dispatches to per-profile *decoder* classes. Each profile implements:
- `encodeQuery()` → Buffer (what to send)
- `decodeResponse(buffer)` → { metric_name: value } (how to parse response)

This mirrors Epilykos's existing profile system for Modbus but generalized for the
wide variety of RS232 protocols.

**Pros:**
- Clean separation of transport vs protocol logic
- Easy to add new inverter brands as new decoder files
- Transport handles port management, errors, timeouts uniformly
- Follows Epilykos's existing pattern (profiles/*.json for Modbus)
- Testable — each decoder can be unit-tested with sample data

**Cons:**
- More upfront design than a flat script
- Streaming protocols (Victron VE.Direct) need special handling vs poll-based ones

**Option B: Per-brand monolithic modules**

Each brand gets its own module (e.g., `rs232/victron.js`, `rs232/voltronic.js`),
each with its own open/read/parse/close logic.

**Pros:**
- Maximum flexibility for each brand
- No framework constraints

**Cons:**
- Massive code duplication (serial port open/close/timeout/error in every file)
- Harder to maintain consistent error handling and logging
- Harder to add new brands (copy-paste-modify)
- Does not follow Epilykos existing patterns

### 3.2 Recommendation: Hybrid Framework

Use a **framework + profile** architecture:

1. **`modules/rs232.js`** — Core module (transport layer, polling orchestrator,
   profile loading). Handles:
   - Opening/closing serial ports
   - Timeouts and error recovery
   - Consecutive failure tracking
   - Query/response cycle (for poll-based protocols)
   - Streaming listener (for push-based protocols)
   - Metrics storage

2. **`profiles/rs232/`** directory — Each inverter protocol gets a profile JSON
   and optionally a companion JS decoder module.

   Simple ASCII protocols (Victron VE.Direct, Voltronic QPIGS) can be fully
   defined in **JSON profile + a generic ASCII decoder**.

   Complex binary protocols (SMA, Goodwe) need a **custom JS decoder module**
   that implements the `encodeQuery()` / `decodeResponse()` interface.

3. **Streaming protocols (Victron VE.Direct)** get a shared `StreamingPortManager`
   that keeps a long-lived serial port open and accumulates frames. Poll-based
   protocols get the standard open/query/close cycle.

### 3.3 Protocol Profiles Structure

**Simple ASCII profile (voltronic.json):**
```json
{
  "name": "Voltronic/Axpert PIP Series",
  "transport": "rs232",
  "protocol": "voltronic-qpigs",
  "defaults": { "baud": 2400, "dataBits": 8, "stopBits": 1, "parity": "none" },
  "commands": [
    {
      "name": "QPIGS",
      "query": "QPIGS\\r\\n",
      "response": { "type": "ascii-line", "prefix": "(" },
      "fields": [
        {"index": 0,  "metric": "grid_voltage",      "scale": 1,   "unit": "V"},
        {"index": 1,  "metric": "grid_frequency",     "scale": 1,   "unit": "Hz"},
        {"index": 2,  "metric": "ac_output_voltage",  "scale": 1,   "unit": "V"},
        {"index": 6,  "metric": "battery_voltage",    "scale": 1,   "unit": "V"},
        {"index": 8,  "metric": "battery_soc",        "scale": 1,   "unit": "%"},
        {"index": 9,  "metric": "inverter_temp",      "scale": 1,   "unit": "°C"},
        {"index": 11, "metric": "solar_voltage",      "scale": 1,   "unit": "V"},
        {"index": 10, "metric": "solar_current",      "scale": 1,   "unit": "A"},
        {"index": 4,  "metric": "load_power",         "scale": 1,   "unit": "W"},
        {"index": 5,  "metric": "load_va",            "scale": 1,   "unit": "VA"}
      ]
    }
  ]
}
```

**Streaming profile (vedirect.json):**
```json
{
  "name": "Victron VE.Direct",
  "transport": "rs232",
  "protocol": "vedirect-streaming",
  "defaults": { "baud": 19200, "dataBits": 8, "stopBits": 1, "parity": "none" },
  "fields": [
    {"label": "V", "metric": "battery_voltage", "scale": 0.001, "type": "millivolt", "unit": "V"},
    {"label": "I", "metric": "battery_current", "scale": 0.001, "type": "milliamp", "unit": "A"},
    {"label": "VPV", "metric": "solar_voltage", "scale": 0.01, "unit": "V"},
    {"label": "PPV", "metric": "solar_power", "scale": 1, "unit": "W"},
    {"label": "SOC", "metric": "battery_soc", "scale": 0.1, "unit": "%"},
    {"label": "T", "metric": "battery_temp", "scale": 0.1, "unit": "°C"},
    {"label": "H1", "metric": "daily_yield", "scale": 0.01, "unit": "kWh", "type": "energy"}
  ]
}
```

---

## 4. Existing Open-Source Libraries / Tools

| Library | Language | Protocol | Notes |
|---------|----------|----------|-------|
| **sbfspot** | C++ | SMA Sunny Boy | Gold-standard SMA decoder; GPL; over 15 years of development |
| **vedirect** | Python | Victron VE.Direct | Very well maintained; MIT license |
| **vedirect-serial** | Node.js | Victron VE.Direct | npm package `vedirect` (exists) |
| **goodwe** | Python | Goodwe (all protocols) | Excellent; supports 100+ models |
| **piapprox** | Python | Voltronic/Axpert | Reference Voltronic decoder |
| **voltronic-inverter** | Python | Voltronic/Axpert | Comprehensive QPIGS parser |
| **node-axpert** | Node.js | Voltronic/Axpert | npm package; simple QPIGS reader |
| **growatt-rs232** | Python | Growatt serial | Decodes Growatt ASCII protocol |
| **pyfronius** | Python | Fronius | Supports both old RS232 and new API |
| **sma-inverter** | Node.js | SMA Sunny Boy | npm package (unmaintained but has protocol docs) |
| **lxp-bridge** | Rust | Luxpower/EG4 | Gold-standard Luxpower library, full protocol + TCP packet spec at [github.com/celsworth/lxp-bridge](https://github.com/celsworth/lxp-bridge) |
| **pylxpweb** | Python | Luxpower/EG4 | Python client library, complete register definitions |
| **solis_modbus** | Python | Solis | HA HACS integration, full register map |
| **eg4-bridge** | Rust | Luxpower/EG4 | Maintained fork of lxp-bridge |
| **powerctrl** | PHP | Infinisolar/Voltronic | Modbus II card protocol for power compensation |
| **node-red-contrib-victron** | Node.js | Victron VE.Direct | Node-RED node with VE.Direct parser |
| **solaredge** | Python | SolarEdge | Focuses on Modbus TCP / monitoring API |
| **huawei-solar** | Python | Huawei SUN2000 | Modbus RTU over serial, not raw RS232 |
| **ESPHome** | YAML/C++ | Many (by component) | Has components for Victron, SMA, Growatt, etc. |
| **OpenDTU** | C++ | Hoymiles | Not RS232 but shows DIY inverter monitoring patterns |

### Key Takeaway
The Node.js ecosystem already has basic implementations for:
- **Victron VE.Direct** (vedirect npm package)
- **Voltronic/Axpert** (node-axpert npm package)
- **SMA** (sma-inverter npm package — unmaintained but code can be adapted)
- **Fronius** (fronius-inverter npm package)

These can serve as reference implementations, but Epilykos's RS232 module should be
built from scratch following Epilykos's own architecture patterns rather than wrapping
these libraries directly (they have incompatible error handling, logging, and data flow).

---

## 5. Fallback / Failover Strategies for Unreliable Serial Connections

### 5.1 Common Failure Modes

| Failure | Symptom | Frequency |
|---------|---------|-----------|
| Port not found (unplugged) | `Error: No such file or directory` | High |
| Permission denied | `Error: EACCES` | Medium (Linux groups) |
| Port busy (another process) | `Error: EBUSY` | Low |
| Inverter powered off | No response (timeout) | Medium |
| Cable noise / interference | Garbled data, parse errors | Low-Medium |
| Baud rate mismatch | Garbage data | Low (misconfiguration) |
| Partial read (buffer fragmentation) | Incomplete frames | Medium (TCP, less on USB) |

### 5.2 Recommended Strategy

**Per-device consecutive failure counter** (already used in dongle.js):

```
consecutiveFails = 0 → poll normally
1-2 consecutive fails → log warning, poll normally
3-4 consecutive fails → wait 2× poll interval (skip every other cycle)
5+ consecutive fails → log error, skip polls until next cycle, close port
On success → reset counter to 0
```

Implementation in the RS232 module:

```javascript
const failCounts = new Map(); // device_name → number

function handlePollError(device, err) {
  const count = (failCounts.get(device.name) || 0) + 1;
  failCounts.set(device.name, count);
  
  if (count >= 5) {
    logger.error(`RS232 ${device.name}: ${count} consecutive failures, throttling`);
    // skip polling for this device for next interval
  } else if (count >= 3) {
    logger.warn(`RS232 ${device.name}: ${count} consecutive failures`);
    // skip alternate polls
  } else {
    logger.warn(`RS232 ${device.name}: poll failed — ${err.message}`);
  }
}

function handlePollSuccess(device) {
  failCounts.set(device.name, 0);
}
```

### 5.3 Port Recovery

- **On port open failure**: Log error, skip device, try again next poll cycle
- **On port busy**: Aggressive retry with increasing backoff (1s, 5s, 10s, 30s)
- **On mid-read failure**: Close port immediately, release file descriptor
- **Periodic port re-scan**: Every N failed attempts, re-list available ports
- **Graceful degradation:** If RS232 fails, Epilykos still gets data from other sources

### 5.4 Caching / Stale Data

- When a poll fails for a device, re-use the **last known good values** in `latest_metrics`
  (SQLite upsert already does this — it only replaces on success)
- Set a `stale_after_seconds` per device (default: 2× poll interval)
- Optionally mark metrics as stale (add `freshness` column or timestamp comparison in UI)

---

## 6. Port Detection & Hotplug Handling on Linux

### 6.1 Linux Serial Port Discovery

```javascript
const { SerialPort } = require('serialport');

// List all available serial ports
const ports = await SerialPort.list();
// Returns: [{ path, manufacturer, serialNumber, pnpId, vendorId, productId, friendlyName }]
```

Typical inverter USB-to-serial adapters appear as:
- `/dev/ttyUSB0` (USB-serial converters — Prolific PL2303, FTDI FT232)
- `/dev/ttyACM0` (USB-ACM devices — Arduino-style, some inverters)
- `/dev/ttyS0`-`/dev/ttyS3` (built-in serial ports — rare on modern hardware)

### 6.2 Device Identification Heuristics

Use `vendorId` and `productId` from `SerialPort.list()` to suggest inverter types:

| USB VID:PID | Common Adapter | Typical Brand |
|-------------|---------------|---------------|
| `067b:2303` | Prolific PL2303 | Generic, Voltronic, Growatt |
| `0403:6001` | FTDI FT232 | Victron VE.Direct, Fronius |
| `10c4:ea60` | CP210x | SMA, Goodwe, various |
| `1a86:7523` | CH340/CH341 | Generic, Voltronic clones |
| `0403:6015` | FTDI FT231X | Victron VE.Direct (official cable) |

For the settings UI, when adding a new RS232 device, the frontend can:
1. Call `/api/rs232/ports` to list available ports with metadata
2. Show a dropdown of detected ports, grouped by known manufacturers
3. Allow manual path entry for advanced users

### 6.3 Hotplug Detection

**Option 1: Periodic polling (recommended for Epilykos)**
- On each 30s poll cycle, call `SerialPort.list()` and compare with last known ports
- If new ports appear and there's an unconfigured inverter-connected port, show a notification
- Log port changes for debugging
- Low overhead — `list()` is fast (no I/O to ports)

```javascript
let knownPorts = [];

async function scanSerialPorts() {
  const ports = await SerialPort.list();
  const currentPaths = ports.map(p => p.path).sort();
  const knownPaths = knownPorts.map(p => p.path).sort();
  
  if (JSON.stringify(currentPaths) !== JSON.stringify(knownPaths)) {
    logger.info(`Serial ports changed: ${currentPaths.join(', ')}`);
    knownPorts = ports;
  }
  return ports;
}
```

**Option 2: udev monitoring (advanced)**

**Option 2: udev monitoring (advanced) — CAVEAT: chokidar does not expand globs against /dev/**

Use the `chokidar` npm package to watch `/dev/` for new device nodes. Note that
chokidar polls the filesystem at its core and glob expansion may not work reliably
against kernel pseudo-filesystems like `/dev/` on all Linux kernels. The recommended
approach is to watch the full directory and filter by name:

```javascript
const chokidar = require('chokidar');
chokidar.watch('/dev', { persistent: true, ignoreInitial: true })
  .on('add', path => {
    if (path.startsWith('/dev/ttyUSB') || path.startsWith('/dev/ttyACM')) {
      logger.info(`New serial port detected: ${path}`);
    }
  })
  .on('unlink', path => {
    if (path.startsWith('/dev/ttyUSB') || path.startsWith('/dev/ttyACM')) {
      logger.info(`Serial port removed: ${path}`);
    }
  });
```

**Option 3: udev rule + script (system-level)**

Create `/etc/udev/rules.d/99-epilykos-inverter.rules`:
```
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="2303", SYMLINK+="epilykos-inverter%n", MODE="0660", GROUP="dialout"
```

This gives consistent symlinks and permissions. Best for production, but requires
root and setup steps in documentation.

### 6.4 Permissions

Most Linux systems require the user to be in the `dialout` group for serial port access:

```bash
sudo usermod -a -G dialout $USER
```

The Epilykos setup documentation should include this step. The RS232 module should
log a clear error if `EACCES` is encountered:

```
RS232 Error: Cannot open /dev/ttyUSB0 — Permission denied.
Ensure your user is in the 'dialout' group: sudo usermod -a -G dialout $USER
```

---

## 7. Summary: Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Module architecture** | Single `modules/rs232.js` + profile-based decoders in `profiles/rs232/*.json` + optional JS decoders in `modules/rs232-decoders/*.js` | Follows existing profile pattern from Modbus; keeps transport logic centralized |
| **Poll vs. streaming** | Hybrid — poll-based for most brands, dedicated streaming reader for Victron VE.Direct | Most inverters are query/response; Victron push model needs different handling |
| **Profile format** | JSON with `commands[]` and `fields[]` arrays, plus `protocol` type field | Extensible, human-editable, testable |
| **Serial library** | `serialport` (v8.x, already available as transitive dep) | Standard Node.js serial library; well maintained |
| **Port detection** | `SerialPort.list()` on demand, periodic refresh in poll loop | Simple, no extra dependencies |
| **Hotplug** | Chokidar watcher on `/dev` with name filter (optional, add as dependency) | Lightweight, real-time notification |
| **Failover** | Per-device consecutive failure counter, exponential backoff, open/close per poll | Matches dongle.js pattern |
| **First profiles** | Voltronic/Axpert (simplest, also covers Infinisolar), Victron VE.Direct (streaming, popular), SolaX Pocket USB (binary AA55) | Highest community demand / hardware availability |
```
