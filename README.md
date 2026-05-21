# Epilykos

> **Multi-source, multi-device energy monitoring.** A self-hosted, real-time dashboard integrating **Home Assistant**, **MQTT**, **Modbus TCP/Serial**, **REST APIs**, and **Bluetooth BMS** devices. Public display with no login required; settings are password-protected.

---

## Features

### Live Data & Flow

- **Flow Card** — colour-coded energy flow diagram with animated arrows for Solar → Battery → Home → Grid.
- **Flow Card 2** — cross/cardinal topology diagram with center hub icon and directional flow lines with animated dots.
- **Flow Card Square** — compact 2×2 grid with icons at corners, data beside icons, configurable metrics.
- **Flow Card Square 2** — same 2×2 grid with flow lines along X/Y axes, animated dots, per-source colour coding.
- **Real-time Stats** — current power (W), battery SoC (%), daily totals (kWh), self-sufficiency, cost savings.
- **Solar Forecast Banner** — 4-day predictions via Solcast or Open-Meteo. Sparkline comparing actual vs forecast with fill gradient. Live clock, weather summary, "remaining today" estimate.
- **Grid Status & Timeline** — binary metric from any source (HA, MQTT, Modbus). ON/OFF state with "since" timestamp, uptime hours (day/week/month/year), 24-hour timeline bar with hover tooltips.

### Modular Dashboard

- **Multiple tabs** — separate dashboards per context.
- **Drag-to-reorder** — drag blocks on the dashboard (SortableJS). Lock/unlock toggle (authenticated users).
- **Absolute positioning** — blocks placed at exact pixel coordinates from the editor. Responsive width via percentage columns.
- **Visual Layout Editor** — `/editor` page with GridStack. Drag blocks from palette, resize, arrange freely. Create/rename/delete dashboards. Positions persist exactly.
- **Per-block configurable** — background colour, transparency toggle, metric mapping, width, height.
- **Desktop/mobile defaults** — auto-switch to different dashboard tabs based on screen width.
- **Multi-instance support** — any block can appear multiple times on the same dashboard.

### Block Types (20)

| Block | Description |
|-------|-------------|
| Flow Card | Animated flow diagram (Solar/Battery/Home/Grid) |
| Flow Card 2 | Cross topology with center hub + animated flow lines |
| Flow Card Square | 2×2 grid, icons at corners |
| Flow Card Square 2 | 2×2 grid with X/Y flow lines |
| Forecast Banner | Solar forecast + sparkline + weather + clock |
| Forecast Sparkline | Standalone sparkline graph |
| Forecast Info | Weather + days + clock without sparkline |
| Metric Cards | Custom stat cards with configurable metrics |
| Multi-Value Card | Multiple metrics on one card (unlimited) |
| Gauge Card | Full-circle SVG gauge |
| Half Gauge | 180° semicircle gauge (positive fills right) |
| Half Gauge 2 | 180° semicircle (positive fills left) |
| Grid Card | Grid status, uptime hours, timeline |
| Power Chart | Line chart (24h/3d) with green/red zone gradients |
| Energy Chart | Bar chart (7d/30d/90d) |
| Savings Summary | Today/week/month/all-time PV savings |
| Daily Table | Last 30 days with configurable columns |
| Monthly Table | Last 12 months with configurable columns |
| Text Card | Freeform HTML/markdown content |
| Embed Card | IFrame for external URL |

### Gauge Variants

- **Gauge Card** — 360° circular gauge. Configurable min/max/color. Label + value centered inside.
- **Half Gauge** — 180° semicircle (9 o'clock to 3 o'clock). Zero at bottom center. Positive fills right, negative fills left.
- **Half Gauge 2** — Same arc, reversed: positive fills from left (9 o'clock), negative from right (3 o'clock).

### Data Sources

- **Home Assistant** — multi-instance, entity mapping per device.
- **MQTT** — multi-broker, topic-to-metric mapping.
- **Modbus TCP & Serial** — profiles for SRNE, Growatt, Deye, Victron, Voltronic.
- **External REST APIs** — poll any HTTP endpoint, map JSON paths to metrics.
- **Bluetooth BMS** — JK, JBD, Daly via Python sidecar (auto-discover, cell voltages).

### Charts & Tables

- **Power Overview** — line chart, 24h/3d range. Green gradient above zero, red below. Configurable datasets with metric/label/color.
- **Daily Energy** — bar chart, 7d/30d/90d range. Configurable datasets.
- **Data Tables** — daily (30 days) and monthly (12 months) with configurable columns (show/hide, change metric per column).

### Customisation

- Light / dark mode (manual or system auto-sync).
- Custom title, logo, and favicon.
- Background colour and background image for the page.
- Global transparency toggle (all blocks).
- Per-block background colour and transparency.
- Electricity rate and currency for savings.
- Backup & restore database.
- Export/import dashboard layout as JSON.

### Real-Time Updates

- **WebSocket** pushes data every 30s with near-instant refresh.
- Automatic fallback to polling (60s) if WebSocket disconnects.

### Security

- Session-based authentication for settings and editor.
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
7. **Dashboard layout:** use the **Editor** (`/editor`) to visually arrange blocks, or configure in Settings → Dashboard.
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
│   ├── editor.html               # Visual layout editor
│   ├── settings.html             # Settings page
│   ├── settings.js               # Settings logic
│   ├── login.html                # Login page
│   ├── style.css                 # Styles
│   └── js/
│       ├── main.js               # Entry: WebSocket, theme, config
│       ├── dashboard.js          # CSS Grid + SortableJS layout
│       ├── editor.js             # GridStack visual editor
│       ├── api.js                # API fetch helpers
│       ├── updater.js            # State update dispatcher
│       ├── charts.js             # Chart.js power & energy charts
│       ├── forecast.js           # Forecast sparkline & weather
│       ├── theme.js              # Light/dark mode
│       ├── tables.js             # Daily/monthly data tables
│       ├── grid.js               # Grid timeline bar
│       ├── utils/
│       │   ├── blockId.js        # Block ID generation
│       │   └── uid.js            # Scoped ID helper
│       └── components/
│           ├── index.js          # Component registry
│           ├── flowCard.js       # Animated flow diagram
│           ├── systemTopology.js # Flow Card 2 (cross topology)
│           ├── flowCardSquare.js # 2×2 square layout
│           ├── flowCardSquare2.js# 2×2 square + flow lines
│           ├── forecastBanner.js # Full forecast banner
│           ├── forecastSparkline.js # Standalone sparkline
│           ├── forecastInfo.js   # Weather + days info card
│           ├── metricCards.js    # Custom stat cards
│           ├── multiValueCard.js # Multi-value card
│           ├── gaugeCard.js      # Full-circle gauge
│           ├── halfGaugeCard.js  # Half gauge
│           ├── halfGauge2Card.js # Half gauge 2 (reversed)
│           ├── gridCard.js       # Grid status & hours
│           ├── chartPower.js     # Power chart
│           ├── chartEnergy.js    # Energy chart
│           ├── savingsSummary.js # Savings display
│           ├── dataTableDaily.js # Daily table
│           ├── dataTableMonthly.js# Monthly table
│           ├── textCard.js       # HTML/markdown content
│           └── iframeCard.js     # IFrame embed
├── bms-bridge/                   # Python FastAPI sidecar for BLE BMS
├── profiles/                     # Modbus register maps (JSON)
└── data/                         # SQLite database (runtime)
```

---

## Configuration Reference

### Dashboard Layout (Settings → Dashboard)

Each block has:
- **Type** — block component
- **Width** — Full, 3/4, 2/3, 1/2, 1/3, 1/4
- **Height** — Auto or fixed px
- **Background** — colour picker
- **Transparent** — per-block toggle
- **Config** — per-block settings (metrics, title, datasets, columns)

### Editor (`/editor`)

- Drag blocks from palette onto grid
- Drag to reposition, drag edges to resize
- Click ✕ to remove a block
- + New / Delete / Rename dashboards
- Save & Exit persists layout

### Per-Block Metric Configuration

| Block | Configurable Metrics |
|-------|---------------------|
| Flow Card | Solar, Battery SOC, Charge/Discharge, Consumption, Grid Import/Export |
| Flow Card 2 | Solar, Grid, Battery Power, Battery SOC, Consumption |
| Flow Card Square / Square 2 | Solar, Grid, Battery Power, Battery SOC, Consumption |
| Grid Card | Grid Status (optional override) |
| Gauge / Half Gauge | Metric, Min, Max, Color |
| Multi-Value Card | Unlimited metrics with Label, Metric, Unit |
| Text Card | HTML/markdown content |
| Embed Card | URL |
| Power/Energy Charts | Datasets: Label, Metric, Color (add/remove) |
| Forecast Banner | Actual energy field for sparkline |
| Daily/Monthly Tables | Columns: Label, Field (show/hide, reorder) |

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
https://github.com/ashipaek0/Epilykos/wiki/Development-Guide 

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
- **GridStack.js** — visual editor
- **MQTT.js** — MQTT client
- **modbus-serial** — Modbus
- **Winston** — logging
- **bleak** — Bluetooth BLE scanning

Solar forecast by **Solcast** and **Open-Meteo**. Icons by **Flaticon** (uicons).
