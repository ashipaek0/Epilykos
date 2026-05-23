<div align="center">

# ⚡ Epilykos

**Self-hosted, real-time energy monitoring — built for solar, inverters, and home automation.**

[![Docker Hub](https://img.shields.io/docker/pulls/irunmole/epilykos?logo=docker&label=Docker%20Pulls&color=2496ED)](https://hub.docker.com/r/irunmole/epilykos)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/irunmole/epilykos?style=flat&logo=github)](https://github.com/irunmole/epilykos)

Connects directly to inverters, Home Assistant, MQTT, Modbus, and REST APIs.  
Public display with no login required — settings are password-protected.

</div>

---

## Table of Contents

- [Quick Start](#quick-start)
- [Docker Compose](#docker-compose)
- [Adding Data Sources](#adding-data-sources)
- [Dashboard Editor](#dashboard-editor)
- [Key Features](#key-features)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Quick Start

```bash
git clone https://github.com/irunmole/epilykos.git
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
    restart: unless-stopped

  bms-bridge:           # optional — Bluetooth BMS only
    image: irunmole/epilykos-bms:latest
    container_name: epilykos-bms
    network_mode: host
    restart: unless-stopped
```

> **Note:** The `bms-bridge` service is only required if you are using a Bluetooth BMS device. It can be omitted otherwise.

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
Supported profiles: **SRNE**, **Deye**, **Growatt**, **Victron**, **Voltronic**.  
Connects via TCP or serial interface.

### External REST API
Point Epilykos at any HTTP API that returns JSON. Map JSON field paths to dashboard metrics.

### Bluetooth BMS
Requires the `bms-bridge` sidecar container. Scan for nearby devices and select the target MAC address.

---

## Dashboard Editor

Open `/editor` to customise your dashboard layout. Blocks can be dragged, resized, and rearranged freely. Each block is independently configurable — choose its metric source, colour scheme, transparency, and font size.

Multiple dashboards are supported, with automatic switching between desktop and mobile layouts.

---

## Key Features

| Feature | Detail |
|---------|--------|
| **Block types** | 20 types — flow diagrams, gauges, charts, tables, forecasts, grid status, text embeds, and more |
| **Multi-instance blocks** | Any block type can appear multiple times with different metric mappings |
| **Per-block configuration** | Metric source, colours, transparency, font size — all configurable independently |
| **Light / Dark mode** | Auto-detect or manual override |
| **Multiple dashboards** | Define separate layouts; desktop/mobile auto-switch |
| **Real-time updates** | WebSocket push every 30 seconds |
| **No forced login** | Dashboard is publicly accessible; only settings require a password |

---

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| **No data displayed** | Verify at least one data source is enabled and actively producing metrics |
| **Settings page unavailable** | Confirm `SETTINGS_PASSWORD` is set correctly in `.env` |
| **Inverter dongle timeout** | Ping the dongle IP from the server and verify the port is reachable |
| **Charts are blank** | Open the browser console (`F12`) and check for JavaScript errors |
| **Need verbose logs** | Set `LOG_LEVEL=debug` in `.env`, then check `logs/` or run `docker compose logs -f` |

---

## License

Epilykos is released under the **GNU General Public License v3.0**.  
See [`LICENSE`](LICENSE) for the full terms.
