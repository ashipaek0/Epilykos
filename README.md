<div align="center">

# ⚡ Epilykos

**Self-hosted, real-time energy monitoring — built for solar, inverters, and home automation.**

[![Docker Hub](https://img.shields.io/docker/pulls/irunmole/epilykos?logo=docker&label=Docker%20Pulls&color=2496ED)](https://hub.docker.com/r/irunmole/epilykos)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ashipaek0/epilykos?style=flat&logo=github)](https://github.com/ashipaek0/epilykos)

Connects directly to inverters, Battery BMS, Home Assistant, over MQTT, Modbus, RS232 serial, Bluetooth, and REST APIs.  
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
cp .env.example .env && nano .env   # set SETTINGS_PASSWORD (optional — see below)
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
    restart: unless-stopped
    ports:
      - "3000:3000"                  # Ignored with network_mode: host (the app then listens on host port 3000)
    volumes:
      - ./data:/app/data
      - /etc/localtime:/etc/localtime:ro
      - /run/dbus:/run/dbus:ro        # Bluetooth BMS / inverter Bluetooth modules: talk to the host's BlueZ over D-Bus.
    environment:
      - TZ=Africa/Lagos              # Time zone for day boundaries. Remove this line to follow the host clock.
    # devices:
    #   - "/dev/ttyUSB0:/dev/ttyUSB0"        # USB serial adapter (RS232 / RS485 inverter or wired BMS). Add more for multiple devices
    # group_add:
    #   - "dialout"                  # Serial port permissions
    #   - "108"                      # the host bluetooth group ID from `getent group bluetooth`. Uncomment and set only if Settings shows "D-Bus denied access to BlueZ"
    #network_mode: "host"            # Host networking is only needed for Tuya LAN broadcast discovery.
```

> **Bluetooth:** Bluetooth BMS and inverter Bluetooth modules are built in. It uses the host's
> Bluetooth adapter through BlueZ over D-Bus, so the only requirement is the `/run/dbus` mount:
>
> - Mount the **`/run/dbus` directory**
> - The host must run BlueZ with a powered adapter: `systemctl status bluetooth` shows *active*, `bluetoothctl show`
>   shows `Powered: yes`.
> - If Settings reports *D-Bus denied access to BlueZ*, add the host's `bluetooth` group ID (`getent group bluetooth`)
>   under `group_add`; on Ubuntu hosts also add `security_opt: [apparmor=unconfined]`.
>
> Drop the mount if you don't use Bluetooth. Drop `devices` and `group_add` if you don't use a USB serial adapter —
> `devices` must list at least one device or be removed entirely.

**Docker Hub image:** `irunmole/epilykos:latest`

---

## Adding Data Sources

Open `/settings`, log in, and navigate to **Data Sources**. Epilykos supports the following source types:

### Inverter Dongle
Wi-Fi / LAN dongles over TCP or the inverter's Bluetooth link. 
Supported protocols: **Solarman V5**, **Modbus TCP**, **Growatt**, **LuxPower**, **Felicity**.
over Bluetooth **Modbus over BLE**, **LuxPower** and **Phocos Any-Grid**.  

Choose **Connection** (TCP/IP or Bluetooth), then the **Profile** — the list only offers profiles that work over the
chosen connection. For TCP/IP enter the dongle's IP address; for Bluetooth use 🔍 Scan. Then test the connection.

**Bluetooth modules:** some inverters ship a Bluetooth module that carries plain Modbus-RTU over BLE, e.g. SRNE and
Renogy-style BT modules. Set Connection to **Bluetooth**, pick your inverter's register profile, use 🔍 Scan to pick
the module's MAC, and test. 
The default characteristics are `ffd1` (write) and `fff1` (notify). If your module uses different ones, you can read them with a BLE explorer app such as nRF Connect. 

Note that many Wi-Fi + Bluetooth dongles use Bluetooth only for Wi-Fi setup and don't serve live data over it.

Dongles usually accept only one Bluetooth connection at a time.

### Home Assistant
Enter your Home Assistant URL and a **Long-Lived Access Token**. Fetch available entities and map them to dashboard metrics.

### MQTT
Enter your broker URL and map MQTT topics to the metrics you want to display.

### Modbus
Supported profiles: **SRNE**, **Deye**, **Growatt**, **Victron**, **Voltronic/Axpert**, **Solis**, **Luxpower**, **Felicity**, **Generic MPPT**.  
Connects via a serial RS-485 adapter or over TCP. 
Only the Victron profile is native Modbus-TCP; the others are RS-485 (Modbus-RTU) register maps, which you can also reach over the network through an RS-485→Ethernet gateway — pick the gateway's framing (Modbus-TCP or RTU over TCP) on the card. 
All profiles are validated against official manufacturer register maps.

### Tuya (Smart Life)

Connect Tuya-compatible smart devices directly on your LAN — no cloud dependency for runtime data. Epilykos polls devices locally via encrypted TCP (port 6668).

**One-time setup:** Enter your Smart Life UID, scan a QR code to authenticate, and all devices are automatically populated with their local keys and DP (Data Point) labels fetched from the cloud. After that, everything runs locally.

**Manual setup:** For devices not discovered via the cloud flow, enter the Device ID, Local Key, and IP Address directly.

### External REST API
Point Epilykos at any HTTP(S) API that returns JSON — on your LAN (e.g. `http://192.168.1.50/status`) or on the internet. Map JSON field paths to dashboard metrics. Loopback and cloud-metadata addresses are blocked.

### Bluetooth BMS
Built in (needs the `/run/dbus` mount, see [Docker Compose](#docker-compose)). 
Scan for nearby devices; recognised BMS are labelled with their type. 
Decoding uses [aiobmsble](https://pypi.org/project/aiobmsble/), which covers JK, JBD, Daly, Seplos, ANT, Renogy, EG4, Pace and many more. 
Values are stored as `bms_<name>_<key>`, e.g. `voltage`,`current`, `battery_level`, `cell_voltage_1`, `temp_1`.

If a rebranded pack is found by Scan but not recognised, set its **type** (JBD, JK, Daly, Seplos, ANT, PACE / PACEEX) next to the
MAC address.

### BMS — Wired (RS485 / UART)
Pick the serial port and a profile; the serial settings follow the profile.
- **JBD / Jiabaida / Xiaoxiang / Overkill Solar** — UART (USB-TTL) or RS485, 9600 8N1.
- **JK-BMS (JK-B / JK-BD)** — JK RS485 adapter or UART port, 115200 8N1. (The newer JK-PB inverter BMS speaks a
  different Modbus protocol and is not covered yet.)
- **PACE (protocol 25)** — PACE's published RS232/RS485 protocol used by many packs (Jakiper, Easun, Tewaycell,
  Greenrich, FSP, Eenovance…), 9600 8N1; set the pack's DIP-switch address. Older protocol-20 packs (e.g. EG4
  LifePower4) are not covered yet.
- **Cworth CE-H6K / CE-LBW-48100C (PACE)** — Modbus-RTU over RS485.

Wired JBD and JK packs report the same metric names as over Bluetooth (`voltage`, `current`, `battery_level`,
`cell_voltage_N`, `temp_N`…), so dashboards and banks work with either connection.

Most BMS and inverter modules accept **one Bluetooth connection at a time**, so close the vendor phone app while
Epilykos is connected. All Bluetooth devices share one adapter and are polled one after another.

### RS232 Serial
Connect inverters via USB-to-RS232/RS485 adapter. Supported protocols:
- **Voltronic QPIGS** — Voltronic, Axpert, Infinisolar, Phocos, MUST, Sako (2400 8N1)
- **Victron VE.Direct** — SmartSolar, BMV, MultiPlus via VE.Direct cable (19200 8N1, streaming)
- **SolaX Pocket USB** — SolaX X1/X3 series via USB-to-TTL adapter (9600 8N1, binary AA55)
- **Modbus-RTU** — e.g. Anern EVO4200L over RS485

Select your inverter's profile, pick the detected serial port, and save. The 30-second poll loop and WebSocket updates work identically to other data sources.

---

## Dashboard Editor

Open `/editor` to customise your dashboard layout. Blocks can be dragged, resized, and rearranged freely. Each block is independently configurable — choose its metric source, colour scheme, transparency, and font size.

Multiple dashboards are supported, with automatic switching between desktop and mobile layouts.

---

## PWA & Network Switching

Epilykos can be installed as a **Progressive Web App** — on your phone or desktop for a native-like app experience.

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
| **Bluetooth** | BMS and inverter Bluetooth modules, built in |
| **No forced login** | Dashboard can publicly accessible; settings require a login |

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
| `BLE_LOG_LEVEL` | `WARNING` | Bluetooth helper log level (`INFO` / `DEBUG` when diagnosing a device) |

---

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| **No data displayed** | Verify at least one data source is enabled and actively producing metrics |
| **Settings page unavailable** | Confirm `SETTINGS_PASSWORD` is set correctly in `.env` |
| **Inverter dongle timeout** | Ping the dongle IP from the server and verify the port is reachable |
| **Charts are blank** | Open the browser console (`F12`) and check for JavaScript errors |
| **RS232 no ports found** | Verify USB-to-serial adapter is connected and user is in the `dialout` group |
| **`EACCES` on `/app/data` / `SQLITE_CANTOPEN` at startup** | Fixed in current images (the container now makes `./data` writable itself). On an older image: `sudo chown -R 1000:1000 ./data` then `docker compose up -d` |
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
npm test                                            # runs every test/*.test.js (no hardware needed)
python3 modules/ble/ble_helper.py --self-test       # Bluetooth helper pure functions
PORT=3002 SETTINGS_PASSWORD=dev node server.js      # local instance (data/ in the working directory)
```

Bluetooth outside Docker needs Python ≥ 3.12 with `pip install -r modules/ble/requirements.txt` and a running BlueZ.

For a complete walkthrough of the codebase architecture — adding new block types, integrating new data sources, settings UI patterns, performance best practices, deployment workflows, and common pitfalls — see the **[Development Guide](https://github.com/ashipaek0/Epilykos/wiki/Development-Guide)** on the wiki.

---

## License

Epilykos is released under the **GNU General Public License v3.0**.  
See [`LICENSE`](LICENSE) for the full terms.
