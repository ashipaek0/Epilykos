# Epilykos

> **Multi-source, multi-device energy monitoring.** A self-hosted, real-time dashboard integrating **Home Assistant**, **MQTT**, **Modbus TCP/Serial**, **REST APIs**, and **Bluetooth BMS** devices. Public display with no login required; settings are password-protected.

![Screenshot 1](https://github.com/user-attachments/assets/0511a0ba-f08c-4f72-918a-59945d3ee456)
![Screenshot 2](https://github.com/user-attachments/assets/d0599cd5-bfd0-45e0-89e0-d8e291e31a0b)

---

## Features

### Live Data & Flow

- **Animated Flow Card** — colour-coded arrows for Solar → Battery → Home → Grid. Icons change colour with activity.
- **Real-time Stats** — current power (W), battery SoC (%), daily totals (kWh), self-sufficiency, cost savings.
- **Solar Forecast Banner** — 4-day predictions via Solcast (API key) or Open-Meteo (free). Hourly sparkline comparing actual vs forecast power, weather summary.
- **Grid Status & Timeline** — ON/OFF state, uptime hours (day/week/month/year), 24-hour timeline bar with hover tooltips.

### Modular Dashboard

- **Multiple tabs** — separate dashboards (e.g. "Main", "Technical", "Living Room").
- **Drag-to-reorder** — drag blocks to rearrange directly on the dashboard (authenticated users).
- **12-column CSS Grid** — stack blocks side-by-side. Each block has configurable width (Full, 3/4, 2/3, 1/2, 1/3, 1/4) and optional min-height.
- **Metric configurability** — every block reads metric names from config. Pick which metrics feed each block from Settings. Fallback defaults mean existing layouts keep working.
- **Available block types:**
  - Flow Card, Solar Forecast Banner, Metric Cards, Grid Card
  - Power Overview Chart, Daily Energy Bar Chart
  - Savings Summary, Last 30 Days Table, Last 12 Months Table
  - Weather Block, Battery Block

### Data Sources

- **Home Assistant** — multi-instance, entity mapping per device.
- **MQTT** — multi-broker, topic-to-metric mapping.
- **Modbus TCP & Serial** — profiles for SRNE, Growatt, Deye, Victron, Voltronic.
- **External REST APIs** — poll any HTTP endpoint, map JSON paths to metrics.
- **Bluetooth BMS** — JK, JBD, Daly via Python sidecar (auto-discover, cell voltages, temperature).

### Charts & Tables

- **Power Overview** — line chart, 24h/3d range, toggle datasets.
- **Daily Energy** — bar chart, 7d/30d/90d range.
- **Data Tables** — collapsible daily (30 days) and monthly (12 months) breakdowns.

### Customisation

- Light / dark mode (manual or system auto-sync).
- Custom title and logo.
- Electricity rate and currency for savings calculation.
- Backup & restore database.
- Layout configuration via Settings (add/remove blocks, change type, width, height, per-block metric mapping).

### Real-Time Updates

- **WebSocket** pushes data every 30s with near-instant refresh.
- Automatic fallback to polling (60s) if WebSocket disconnects.

### Security

- Session-based authentication for settings.
- Rate limiting on login.
- CSRF protection.
- Structured logging (Winston) with rotation.

---

## Quick Start (Docker Compose)

### 1. Clone

```bash
git clone https://github.com/yourusername/epilykos.git
cd epilykos
```

### 2. Configure

```bash
nano .env   # set SETTINGS_PASSWORD to a strong password
```

### 3. Start

```bash
docker compose up -d --build
```

Dashboard: `http://localhost:3000`

### 4. Add Data Sources

1. Open `http://your-ip:3000/settings`, log in with username `admin` and your `.env` password.
2. **Home Assistant:** add URL, token, fetch entities, map metrics.
3. **MQTT:** add broker URL, map topics to metrics.
4. **Modbus:** pick profile, configure TCP or serial.
5. **BMS:** scan for devices, select MAC address.
6. **Solar Forecast:** set latitude, longitude, capacity. Optionally add Solcast API key.
7. **Dashboard layout:** add/remove blocks, set type, width, height, configure per-block metrics.
8. Click **Save All Settings**.

---

## Project Structure

```
epilykos/
├── server.js                     # Express entry point
├── modules/                      # Backend
│   ├── database.js               # SQLite (WAL mode)
│   ├── ha.js                     # Home Assistant polling
│   ├── mqtt.js                   # MQTT broker connections
│   ├── modbus.js                 # Modbus TCP/Serial
│   ├── external.js               # REST API polling
│   ├── bms.js                    # Bluetooth BMS bridge
│   ├── solar.js                  # Solar forecast (Solcast/Open-Meteo)
│   ├── grid.js                   # Grid status tracking
│   ├── history.js                # Legacy history snapshots
│   ├── metrics.js                # Current metrics query
│   ├── metricsManager.js         # User-created metrics CRUD
│   ├── dashboard-config.js       # Layout config
│   ├── savings.js                # Cost savings
│   ├── backup.js                 # Database backup/restore
│   ├── sessionAuth.js            # Auth, CSRF, rate limiting
│   ├── logger.js                 # Winston logger
│   └── utils.js                  # Grid state parser
├── public/
│   ├── index.html                # Main dashboard
│   ├── style.css                 # Styles (CSS Grid layout)
│   ├── settings.html / settings.js  # Settings page
│   └── js/
│       ├── main.js               # Entry: WebSocket, theme, config
│       ├── dashboard.js          # CSS Grid + SortableJS layout
│       ├── api.js                # API fetch helpers
│       ├── updater.js            # State update dispatcher
│       ├── charts.js             # Chart.js power & energy charts
│       ├── forecast.js           # Forecast sparkline & weather
│       ├── theme.js              # Light/dark mode
│       ├── tables.js             # Daily/monthly data tables
│       ├── grid.js               # Grid timeline bar
│       └── components/
│           ├── flowCard.js       # Animated flow diagram
│           ├── forecastBanner.js # Solar forecast banner
│           ├── metricCards.js    # Custom stat cards
│           ├── gridCard.js       # Grid status & hours
│           ├── chartPower.js     # Power chart builder
│           ├── chartEnergy.js    # Energy chart builder
│           ├── savingsSummary.js # Savings display
│           ├── dataTableDaily.js # Daily data table
│           ├── dataTableMonthly.js# Monthly data table
│           ├── weatherBlock.js   # Weather display
│           └── batteryBlock.js   # Battery metrics
├── bms-bridge/                   # Python FastAPI sidecar for BLE BMS
├── profiles/                     # Modbus register maps (JSON)
└── data/                         # SQLite database (runtime)
```

---

## Configuration Reference

### Dashboard Layout

Each block in settings has:
- **Type** — block component
- **Width** — Full, 3/4, 2/3, 1/2, 1/3, 1/4 (12-column grid)
- **Height** — Auto or fixed px
- **Config** — per-block settings (metrics, title, datasets, visibility)

Blocks are rendered in a 12-column CSS Grid. Drag to reorder on the dashboard (SortableJS). Changes persist on save.

### Per-Block Metric Configuration

Each block type can override which metrics it reads:

| Block | Configurable Metrics |
|-------|---------------------|
| Battery | SOC, Voltage, Current, Power, Temperature |
| Flow Card | Solar, Battery SOC, Charge/Discharge, Consumption, Grid Import/Export |
| Grid Card | Grid Status (optional override) |
| Power/Energy Charts | Datasets: Label, Metric, Color (add/remove freely) |
| Forecast Banner | Actual energy field for sparkline |

All blocks fall back to sensible defaults if no config is set — existing layouts keep working.

### Home Assistant (Multi-Device)

| Setting | Description |
|---------|-------------|
| **Name** | Friendly label |
| **URL** | `http://homeassistant.local:8123` |
| **Token** | Long-Lived Access Token |
| **Entity mappings** | Metric name → Entity ID |

### MQTT (Multi-Broker)

| Setting | Description |
|---------|-------------|
| **Broker URL** | `mqtt://broker:1883` |
| **Topic mappings** | Metric name → Topic |

### Modbus

| Setting | Description |
|---------|-------------|
| **Transport** | TCP/IP or Serial |
| **Profile** | Pre-defined register map |
| **Host/Port** | TCP settings |
| **Serial path** | `/dev/ttyUSB0` etc. |

### Bluetooth BMS

| Setting | Description |
|---------|-------------|
| **MAC address** | Found via Scan button |
| **Enabled** | Toggle polling |

BMS metrics are auto-prefixed: `bms_<name>_voltage`, etc.

### Solar Forecast

| Setting | Description |
|---------|-------------|
| **Latitude / Longitude** | Panel position |
| **System Capacity** | kWp |
| **Solcast API Key** | Optional, high accuracy |

---

## Docker Hub

Pre-built images:
- **Dashboard:** `irunmole/epilykos:latest`
- **BMS bridge:** `irunmole/epilykos-bms:latest`

---

## Development

```bash
npm install
npm start
```

Server on port 3000. Database in `./data`.

BMS bridge (Python 3.12+):
```bash
cd bms-bridge
pip install -r requirements.txt
python bms_bridge.py
```

---

## License

GNU General Public License v3.0 — see `LICENSE`.

---

## Acknowledgements

- **Express.js** — backend
- **Chart.js** — charts
- **SQLite** — storage
- **SortableJS** — drag-to-reorder
- **MQTT.js** — MQTT client
- **modbus-serial** — Modbus
- **Winston** — logging
- **bleak** — Bluetooth BLE scanning

Solar forecast by **Solcast** and **Open-Meteo**. Icons by **Flaticon** (uicons).
