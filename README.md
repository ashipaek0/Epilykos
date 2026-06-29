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
nano .env   # set SETTINGS_PASSWORD
docker compose up -d
```

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
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"     # RS232 serial passthrough
    group_add:
      - "dialout"                        # Serial port permissions
    restart: unless-stopped

  bms-bridge:           # optional — Bluetooth BMS only
    image: irunmole/epilykos-bms:latest
    container_name: epilykos-bms
    network_mode: host
    restart: unless-stopped
```

> **Note:** The `bms-bridge` service is only required if you are using a Bluetooth BMS device. It requires `network_mode: host` to access the host's Bluetooth adapter.

**Docker Hub images:**
- `irunmole/epilykos:latest`
- `irunmole/epilykos-bms:latest`

---

## Adding Data Sources

Open `/settings`, log in, and navigate to **Data Sources**. Epilykos supports the following source types:

### Inverter Dongle
Direct TCP connection to WiFi dongles. Supported protocols: **Solarman V5**, **Modbus TCP**, **Growatt**.  
Select a profile, enter the dongle IP address, and test the connection.

### Home Assistant
Enter your Home Assistant URL and a **Long-Lived Access Token**. Fetch available entities and map them to dashboard metrics.

### MQTT
Enter your broker URL and map MQTT topics to the metrics you want to display.

### Modbus
Supported profiles: **SRNE**, **Deye**, **Growatt**, **Victron**, **Voltronic/Axpert**, **Solis**, **Luxpower**, **Felicity**, **Generic MPPT**.  
Connects via TCP or serial interface. All profiles are validated against official manufacturer register maps.

### External REST API
Point Epilykos at any HTTP API that returns JSON. Map JSON field paths to dashboard metrics.

### Bluetooth BMS
Requires the `bms-bridge` sidecar container. Scan for nearby BLE devices and select the target MAC address.

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
| **BMS Bluetooth** | Native BLE support via bms-bridge sidecar |
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
| **BMS scan returns no devices** | Ensure `bms-bridge` uses `network_mode: host` and the host has an active Bluetooth adapter |
| **Need verbose logs** | Set `LOG_LEVEL=debug` in `.env`, then check `logs/` or run `docker compose logs -f` |

---

## Development

For a complete walkthrough of the codebase architecture — adding new block types, integrating new data sources, settings UI patterns, performance best practices, deployment workflows, and common pitfalls — see the **[Development Guide](https://github.com/ashipaek0/Epilykos/wiki/Development-Guide)** on the wiki.

---

## License

Epilykos is released under the **GNU General Public License v3.0**.  
See [`LICENSE`](LICENSE) for the full terms.
