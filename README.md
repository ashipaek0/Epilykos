<div align="center">

# ⚡ Epilykos

**Self-hosted, real-time energy monitoring — built for solar, inverters, and home automation.**

[![Docker Hub](https://img.shields.io/docker/pulls/irunmole/epilykos?logo=docker&label=Docker%20Pulls&color=2496ED)](https://hub.docker.com/r/irunmole/epilykos)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ashipaek0/epilykos?style=flat&logo=github)](https://github.com/ashipaek0/epilykos)

Connects directly to inverters, Home Assistant, MQTT, Modbus, RS232 serial, Bluetooth BMS, and REST APIs.  
Public display with no login required — settings are password-protected.  
**PWA** with real-time WebSocket push, network auto-switching, and background sync.

</div>

---

## Table of Contents

- [Quick Start](#quick-start)
- [Docker Compose](#docker-compose)
- [Adding Data Sources](#adding-data-sources)
- [Dashboard Editor](#dashboard-editor)
- [PWA & Network Switching](#pwa--network-switching)
- [Key Features](#key-features)
- [Reverse Proxy](#reverse-proxy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Quick Start

```bash
git clone https://github.com/ashipaek0/epilykos.git
cd epilykos
nano .env   # set SETTINGS_PASSWORD (optional — see below)
docker compose up -d
```

Then open `http://localhost:3000/setup`. If you set `SETTINGS_PASSWORD`, the wizard asks for it.
Otherwise it asks for a one-time **setup code** printed in the server log
(`docker compose logs epilykos | grep "setup code"`) before you choose the admin password.

| URL | Purpose |
|-----|---------|
| `http://localhost:3000` | Live dashboard (public, no login) |
| `http://localhost:3000/settings` | Settings panel (password-protected) |
| `http://localhost:3000/editor` | Dashboard layout editor |

---

## Docker Compose

```yaml
services:
  epilykos:
    image: irunmole/epilykos:latest
    container_name: epilykos
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./.env:/app/.env
      - /etc/localtime:/etc/localtime:ro  # follow the host time zone…
      - /run/dbus:/run/dbus:ro           # Bluetooth (optional) — host BlueZ over D-Bus
    environment:
      - TZ=Africa/Lagos                    # …unless TZ is set (remove to use the host)
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"     # RS232 serial passthrough
    group_add:
      - "dialout"                        # Serial port permissions
    restart: unless-stopped
```

> **Bluetooth:** Bluetooth BMS and inverter Bluetooth modules are built into the main container. It uses the host's
> Bluetooth adapter through BlueZ over D-Bus, so the only requirement is the `/run/dbus` mount. It does **not** need
> `network_mode: host` or `privileged`. The host must run BlueZ (`bluetoothd`) with a powered adapter. Drop the mount if
> you don't use Bluetooth.

**Docker Hub image:** `irunmole/epilykos:latest`

> **Upgrading from the `bms-bridge` sidecar:** remove the `bms-bridge` service and `BMS_BRIDGE_URL`, and add the
> `/run/dbus` mount above. While `BMS_BRIDGE_URL` is set, Epilykos keeps using the old sidecar, so you can switch over when
> it suits you. The `irunmole/epilykos-bms` image is no longer built.

---

## Adding Data Sources

Open `/settings`, log in, and navigate to **Data Sources**. Epilykos supports the following source types:

### Inverter Dongle
Direct TCP connection to WiFi dongles. Supported protocols: **Solarman V5**, **Modbus TCP**, **Growatt**.  
Select a profile, enter the dongle IP address, and test the connection.

**Bluetooth modules:** some inverters ship a Bluetooth module that carries plain Modbus-RTU over BLE, e.g. SRNE and
Renogy-style BT modules. Pick a register profile for your inverter, set the transport to **Bluetooth (Modbus over BLE)**,
use 🔍 Scan to pick the module's MAC, and test. The default characteristics are `ffd1` (write) and `fff1` (notify). If
your module uses different ones, you can read them with a BLE explorer app such as nRF Connect. Note that many Wi-Fi +
Bluetooth dongles use Bluetooth only for Wi-Fi setup and don't serve live data over it.

**Phocos Any-Grid PSW-H (Bluetooth):** the inverter's display has built-in Bluetooth (the link the PhocosLink app uses).
Choose Connection **Bluetooth**, profile **Phocos Any-Grid PSW-H (Bluetooth)**, Scan and pick the device (it advertises
its serial number, e.g. `ID9634…`). It is read-only and needs no pairing: Epilykos reads output, battery voltage/SOC/
discharge current, heatsink temperature and both PV strings, and never writes to the inverter. Close the PhocosLink
app first. Decoded on display firmware 00041.00; SOC, temperature and discharge current are inferred from live data.

### Home Assistant
Enter your Home Assistant URL and a **Long-Lived Access Token**. Fetch available entities and map them to dashboard metrics.

### MQTT
Enter your broker URL and map MQTT topics to the metrics you want to display.

### Modbus
Supported profiles: **SRNE**, **Deye**, **Growatt**, **Victron**, **Voltronic/Axpert**, **Solis**, **Luxpower**, **Felicity**, **Generic MPPT**.  
Connects via TCP or serial interface. All profiles are validated against official manufacturer register maps.

### Tuya (Smart Life)

Connect Tuya-compatible smart devices directly on your LAN — no cloud dependency for runtime data. Epilykos polls devices locally via encrypted TCP (port 6668).

**One-time setup:** Enter your Smart Life UID, scan a QR code to authenticate, and all devices are automatically populated with their local keys and DP (Data Point) labels fetched from the cloud. After that, everything runs locally.

**Manual setup:** For devices not discovered via the cloud flow, enter the Device ID, Local Key, and IP Address directly.

### External REST API
Point Epilykos at any HTTP(S) API that returns JSON — on your LAN (e.g. `http://192.168.1.50/status`) or on the internet. Map JSON field paths to dashboard metrics. Loopback and cloud-metadata addresses are blocked.

### Bluetooth BMS
Built in (needs the `/run/dbus` mount, see [Docker Compose](#docker-compose)). Scan for nearby devices; recognised BMS
are labelled with their type. Decoding uses [aiobmsble](https://pypi.org/project/aiobmsble/), which covers JK, JBD,
Daly, Seplos, ANT, Renogy, EG4, Pace and many more. Values are stored as `bms_<name>_<key>`, e.g. `voltage`,
`current`, `battery_level`, `cell_voltage_1`, `temp_1`.

Most BMS and inverter modules accept **one Bluetooth connection at a time**, so close the vendor phone app while
Epilykos is connected. All Bluetooth devices share one adapter and are polled one after another.

### RS232 Serial
Connect inverters via USB-to-RS232/RS485 adapter. Supported protocols:
- **Voltronic QPIGS** — Voltronic, Axpert, Infinisolar, Phocos, MUST, Sako (2400 8N1)
- **Victron VE.Direct** — SmartSolar, BMV, MultiPlus via VE.Direct cable (19200 8N1, streaming)
- **SolaX Pocket USB** — SolaX X1/X3 series via USB-to-TTL adapter (9600 8N1, binary AA55)

Select your inverter's profile, pick the detected serial port, and save. The 30-second poll loop and WebSocket updates work identically to other data sources.

---

## Dashboard Editor

Open `/editor` to customise your dashboard layout. Blocks can be dragged, resized, and rearranged freely. Each block is independently configurable — choose its metric source, colour scheme, transparency, and font size.

Multiple dashboards are supported, with automatic switching between desktop and mobile layouts.

---

## PWA & Network Switching

Epilykos is a **Progressive Web App** — install it on your phone or desktop for a native-like experience.

| Feature | Detail |
|---------|--------|
| **Installable** | Add to home screen on iOS/Android/desktop |
| **Offline shell** | Static assets cached via Service Worker |
| **Real-time WebSocket** | Live dashboard updates pushed every 30s |
| **Background sync** | Periodic refresh every minute (keeps metrics fresh even when tab is closed) |
| **Network auto-switch** | Configure local (LAN) and remote (WAN) URLs in Settings — the app tries local first, falls back to remote |
| **IndexedDB cache** | Dashboard state persisted — instant load on app reopen |

> **Note:** Network switching requires the Service Worker. On first load, open Settings and save your local and remote URLs — they'll be sent to the Service Worker for routing.

---

## Key Features

| Feature | Detail |
|---------|--------|
| **Block types** | 20+ types — flow diagrams, gauges, charts, tables, forecasts, grid status, text embeds, and more |
| **Multi-instance blocks** | Any block type can appear multiple times with different metric mappings |
| **Per-block configuration** | Metric source, colours, transparency, font size — all configurable independently |
| **Light / Dark mode** | Auto-detect or manual override |
| **Multiple dashboards** | Define separate layouts; desktop/mobile auto-switch |
| **Real-time updates** | WebSocket push every 30 seconds |
| **Searchable Help** | Accordion-based help section with search — covers all sources and block types |
| **PWA** | Installable, offline-capable, background sync |
| **Bluetooth** | BMS and inverter Bluetooth modules, built in (no sidecar) |
| **No forced login** | Dashboard is publicly accessible; only settings require a password |

---

## Reverse Proxy

### WebSocket Support

Epilykos uses WebSocket connections for real-time dashboard updates. If you're running behind a reverse proxy (Caddy, Nginx, Traefik, Cloudflare), ensure WebSocket upgrade headers are forwarded.

**Caddy:**
```caddy
your-domain.com {
    reverse_proxy localhost:3000 {
        header_up Upgrade {http.request.header.Upgrade}
        header_up Connection {http.request.header.Connection}
        flush_interval -1
    }
}
```

**Nginx:**
```nginx
location /ws {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

**Service Worker note:** If you're using the PWA's network auto-switch, the Service Worker intentionally does **not** intercept `/ws` paths — WebSocket connections must reach the browser's native WebSocket stack directly. Intercepting them via `fetch()` would immediately close the connection.

### Cloudflare

If proxying through Cloudflare (orange cloud), WebSocket is supported on all plans. Ensure:
- The domain has Cloudflare's proxy enabled (not DNS-only)
- No firewall rules block WebSocket traffic

---

## Health check & runtime settings

`GET /healthz` (no login) returns `200 {"status":"ok",…}` once the app is serving and its database opens with the expected schema, and `503` otherwise. It never depends on the network, so a box with no Internet stays healthy. The Docker image uses it as its `HEALTHCHECK`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_TO_FILE` | `true` | `false` logs to stdout/stderr only (no `logs/` directory) — for read-only container roots |
| `LOG_DIR` | `logs/` | Where rotating log files go when file logging is on |
| `SQLITE_SYNCHRONOUS` | `NORMAL` | SQLite durability: `NORMAL`, `FULL` or `EXTRA` (`OFF` is refused) |
| `TMPDIR` | `/tmp` | Temporary directory for uploads (backup restore, layout import) |
| `BLUETOOTH` | `on` | `off` disables Bluetooth even when `/run/dbus` is mounted |
| `BLE_KEEP_ALIVE` | `true` | Keep Bluetooth connections open between polls (`false` reconnects every poll: slower, frees adapter slots) |
| `BMS_BRIDGE_URL` | — | Deprecated: use a legacy `bms-bridge` sidecar instead of built-in Bluetooth |

All persistent state — `energy.db`, snapshots, `session-secret`, `settings-password` — lives in `data/` (`/app/data` in the container).

---

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| **No data displayed** | Verify at least one data source is enabled and actively producing metrics |
| **Settings page unavailable** | Confirm `SETTINGS_PASSWORD` is set correctly in `.env` |
| **Inverter dongle timeout** | Ping the dongle IP from the server and verify the port is reachable |
| **Charts are blank** | Open the browser console (`F12`) and check for JavaScript errors |
| **RS232 no ports found** | Verify USB-to-serial adapter is connected and user is in the `dialout` group |
| **RS232 permission denied** | `sudo usermod -a -G dialout $USER` then log out and back in |
| **RS232 scan error (ENOENT)** | Ensure the container has `udev` installed — the Docker image includes it by default |
| **WebSocket fails ("closed before connection is established")** | If using the PWA, unregister the old Service Worker and reload; also check [WebSocket reverse proxy configuration](#websocket-support) |
| **Bluetooth unavailable: mount the host D-Bus socket** | Add `- /run/dbus:/run/dbus:ro` to the `epilykos` volumes and recreate the container |
| **Bluetooth: D-Bus denied access to BlueZ** | The host's BlueZ D-Bus policy doesn't allow the container user (uid 1000). Add the host's `bluetooth` group ID via `group_add` (`getent group bluetooth`). On Ubuntu hosts with AppArmor D-Bus mediation, also add `security_opt: [apparmor=unconfined]` |
| **Bluetooth: no adapter / adapter powered off** | Check `bluetoothctl show` on the host; `rfkill unblock bluetooth` and `bluetoothctl power on` |
| **BMS scan returns no devices** | Move the adapter closer (BLE range is ~10 m), close the vendor app, and scan again. On a Raspberry Pi 3 a USB Bluetooth dongle is more reliable than the onboard radio |
| **Daily totals roll over at the wrong hour** | Set `TZ` (e.g. `TZ=Europe/Berlin`) or mount `/etc/localtime:/etc/localtime:ro`; the startup log line shows the active time zone |
| **Setup wizard asks for a setup code** | It is printed at startup: `docker compose logs epilykos \| grep "setup code"` |
| **Need verbose logs** | Set `LOG_LEVEL=debug` in `.env`, then check `logs/` or run `docker compose logs -f` |

---

## Development

```bash
npm ci
npm test   # runs every test/*.test.js
```

For a complete walkthrough of the codebase architecture — adding new block types, integrating new data sources, settings UI patterns, performance best practices, deployment workflows, and common pitfalls — see the **[Development Guide](https://github.com/ashipaek0/Epilykos/wiki/Development-Guide)** on the wiki.

---

## License

Epilykos is released under the **GNU General Public License v3.0**.  
See [`LICENSE`](LICENSE) for the full terms.
