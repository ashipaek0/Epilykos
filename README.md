# ⚡ Epilykos

> **Multi‑source, multi‑device, infinitely customisable.** A self‑hosted, real‑time energy monitoring dashboard that integrates with **Home Assistant**, **MQTT**, **Modbus TCP/Serial**, **any REST API**, and **Bluetooth BMS** devices. Designed for public displays – no login required for viewing, while settings are password‑protected.

A self‑hosted, real‑time energy monitoring dashboard that integrates with **Home Assistant**, **MQTT**, **Modbus TCP/Serial**, **any REST API**, and now **Bluetooth BMS** devices. Designed for public displays – no login required for viewing, while settings are password‑protected.

![Screenshot 1](https://github.com/user-attachments/assets/0511a0ba-f08c-4f72-918a-59945d3ee456)
![Screenshot 2](https://github.com/user-attachments/assets/d0599cd5-bfd0-45e0-89e0-d8e291e31a0b)
![Screenshot 3](https://github.com/user-attachments/assets/35f69b77-0695-48d4-b1d8-9cb9481990d7)
![Screenshot 4](https://github.com/user-attachments/assets/0fdc6430-fbcf-438d-9074-f466fe92b363)
![Screenshot 5](https://github.com/user-attachments/assets/6498c54d-119e-4754-a2d1-2f672d1624d1)
![Screenshot 6](https://github.com/user-attachments/assets/655d143e-f1c2-4bd5-8ff2-39333b9e0f16)

---

## ✨ Features

### 📊 Live Data & Flow Visualisation

- **Animated Flow Card** – Colour‑coded arrows show power flowing between **Solar**, **Battery**, **Home**, and **Grid**. Icons change colour based on activity.
- **Real‑time Stats** – Current power (W), battery state of charge (%), daily totals (kWh), self‑sufficiency, and cost savings.
- **Solar Forecast Banner** – Predicts solar generation for the next 4 days using high‑accuracy **Solcast** (with API key) or free **Open‑Meteo** as fallback. Includes hourly sparkline, weather summary, and daily predictions.
- **Grid Status & Timeline** – Current grid state (ON/OFF), uptime hours (day/week/month/year), and a 24‑hour timeline bar with hover tooltips. Displays when the current state began (e.g. "ON since 2:30 PM").

### 🎨 Modular Dashboard Design

- **Multiple tabs** – Create separate dashboard tabs (e.g. "Main", "Technical", "Living Room") with custom layouts
- **Drag‑and‑drop blocks** – Reorder blocks directly from Settings. Available block types:
  - Flow Card
  - Solar Forecast Banner
  - Metric Cards (custom stat cards)
  - Grid Card
  - Power Overview Chart
  - Daily Energy Bar Chart
  - Savings Summary
  - Last 30 Days Table
  - Last 12 Months Table
  - Weather Block
  - Battery Block

- **Per‑block configuration** – Customise individual blocks:
  - **Charts:** Title and dataset visibility (load, solar, battery, grid)
  - **Flow Card:** Toggle solar gauge
  - **Grid Card:** Toggle timeline bar
  - **Savings Summary:** Custom title and show/hide periods
  - **Weather / Battery blocks:** Custom titles

- **Custom metric cards** – Add unlimited stat cards with title, metric, unit. Live updates from all data sources
- **Export / Import layouts** – Share dashboard configurations as JSON files

### 🔌 Multiple Data Sources

- **Home Assistant (multi‑device)** – Multiple instances, each with own URL, token, entity mappings
- **MQTT (multi‑broker)** – Multiple brokers with flexible topic-to-metric mapping
- **Modbus TCP & Serial** – Direct polling with profiles for SRNE, Growatt, Deye, Victron, Voltronic, and more
- **External REST APIs** – Poll any HTTP endpoint and map JSON paths to metrics
- **Bluetooth BMS** ⭐ **NEW** – Monitor JK, JBD, Daly, and other BMS via lightweight sidecar. Auto-discover devices, read voltage, current, SOC, temperature, cell voltages
- **Dynamic metric mapping** – Define any metric names (e.g. `grid_voltage`, `inverter_temp`). Built-in tooltip shows all available metrics

### 📈 Interactive Charts & Tables

- **Power Overview Chart** – Line chart with range selector (24h / 3d). Filter datasets. Smooth gradients
- **Daily Energy Bar Chart** – Range selector (7d / 30d / 90d) for solar, grid import, consumption
- **Collapsible data tables:**
  - **Last 30 Days** – Daily totals
  - **Last 12 Months** – Monthly breakdown

### 🎛️ Customisation & Management

- **Light / Dark mode** – Manual toggle or system auto-sync
- **Branding** – Custom title and logo
- **Savings calculation** – Electricity rate and currency
- **Backup & Restore** – Download/upload entire database
- **Layout Export / Import** – Share JSON files
- **Connection testing** – Verify all data sources from Settings
- **Responsive design** – Desktop, tablet, mobile optimised

### ⚡ Real‑Time Updates (WebSocket)

- **Near‑instant refresh** – Persistent WebSocket connection pushes data immediately (every 30s)
- **Automatic fallback** – Falls back to polling (60s) if WebSocket fails
- **Zero‑latency updates** – No lag or manual refreshes

### 🧠 Central Metric Management

- **Metrics tab** – View all metrics, last value, and unit
- **Create custom metrics** – Define name and unit; appears in all dropdowns
- **Delete metrics** – Removes from mappings and stored data
- **Dropdown selection** – Choose from existing metrics (prevents typos)

### 🔐 Security & Logging

- **Session‑based authentication** 
- **Structured logging** (Winston) – Log levels, file rotation (`./logs/`)
- **Rate limiting**
- **CSRF protection**

---

## 🚀 Quick Start (Docker Compose)

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/epilykos.git
cd epilykos
```

### 2. Create Environment File

```bash
cp .env.example .env
nano .env   # Edit SETTINGS_PASSWORD to a strong password
```

The `.env` file is excluded from version control and keeps your password secure.

### 3. Start the Containers

For a full installation including the optional Bluetooth BMS bridge:

```bash
docker compose up -d --build
```

The dashboard is now available at `http://localhost:3000`.

### 4. Configure Data Sources

1. Open `http://your-ip:3000/settings`
2. Log in with username `admin` and your `.env` password
3. **Add Home Assistant device:**
   - Enter name, URL (e.g. `http://homeassistant.local:8123`)
   - Generate and paste a Long‑Lived Access Token
   - Click **Fetch Entities** to load sensors
   - Map metric names to entity IDs
4. **Optionally add:**
   - MQTT brokers with topic mappings
   - Modbus devices (TCP or serial)
   - External REST API sources
   - Bluetooth BMS devices (scan for devices, select MAC address)
5. **Set up Solar Forecast** (optional):
   - Enter latitude, longitude, system capacity
   - Optionally add Solcast API key
   - Click **Test Forecast**
6. **Customise dashboard layout:**
   - Add/remove tabs and blocks
   - Configure each block's settings
   - Add metric cards
7. Click **Save All Settings**

The dashboard immediately begins displaying live data.

---

## 🔧 Configuration Reference

### Home Assistant (Multi‑Device)

| Setting | Description |
|---------|-------------|
| **Name** | Friendly label for this HA instance |
| **URL** | Address (e.g. `http://homeassistant.local:8123`) |
| **Token** | Long‑Lived Access Token (HA profile → Security) |
| **Poll interval** | Seconds between fetches (default: 30) |
| **Entity mappings** | Metric name → Entity ID (e.g. `solar` → `sensor.pv_power`) |
| **Fetch Entities** | Auto-populate entity dropdowns |
| **+ Add Metric Mapping** | Create custom metrics; tooltip shows all available |

### MQTT (Multi‑Broker)

| Setting | Description |
|---------|-------------|
| **Broker URL** | `mqtt://broker:1883` or `mqtt+tls://...` |
| **Username / Password** | Optional authentication |
| **Topic mappings** | Metric name → Topic (e.g. `consumption` → `energy/load`) |
| **Test Broker** | Verify connection |
| **Test Topic** | Confirm topic is being received |

### Modbus (TCP and Serial)

| Setting | Description |
|---------|-------------|
| **Transport** | TCP/IP or Serial (USB/RS485) |
| **Profile** | Pre‑defined register maps (SRNE, Growatt, Deye, Victron, etc.) |
| **Host / Port (TCP)** | IP address and port (default: 502) |
| **Serial path (Serial)** | e.g. `/dev/ttyUSB0`, `/dev/ttyAMA0` |
| **Baud rate (Serial)** | 9600, 19200, 115200, etc. |
| **Unit ID** | Slave ID (typically 1) |
| **Poll interval** | How often to read registers (seconds) |

### External REST API

| Setting | Description |
|---------|-------------|
| **Name** | Friendly label |
| **URL** | HTTP/HTTPS endpoint (e.g. `https://api.weather.com/data`) |
| **Metric mappings** | JSON path → metric name (e.g. `data.temp` → `outside_temp`) |
| **Global poll interval** | How often to fetch all sources (seconds, default: 60) |
| **Test** | Fetch and verify extraction |

### Bluetooth BMS ⭐ **NEW**

| Setting | Description |
|---------|-------------|
| **Name** | Friendly label (e.g. "Battery1") |
| **MAC address** | Bluetooth address of the BMS (found via Scan button) |
| **Enabled** | Toggle polling |
| **Test Connection** | Verify the bridge can read data |
| **Scan** | Discover nearby BLE devices that look like BMS |

> **Note:** BMS metrics are automatically prefixed with `bms_<name>_` (e.g. `bms_battery1_voltage`).

### Solar Forecast

| Setting | Description |
|---------|-------------|
| **Enable** | Toggle predictions |
| **Latitude / Longitude** | Panel position |
| **Tilt / Azimuth** | Panel angles (degrees) |
| **System Capacity (kWp)** | Total peak power (e.g. 5.0) |
| **Solcast API Key** | Optional; high‑accuracy. Falls back to Open‑Meteo |
| **Loss Factor** | Inverter/wiring losses (0–1, default 0.9) |
| **Installation date** | For degradation calculations (Solcast only) |

### Dashboard Layout

For each dashboard (tab):

- **Add / Remove blocks** using ➕ and ✕ buttons
- **Change block type** from dropdown
- **Reorder blocks** via drag-and-drop
- **Configure individual blocks** by clicking ⚙️:
  - Charts: title, dataset visibility
  - Flow Card: show/hide gauge
  - Grid Card: show/hide timeline
  - Savings Summary: title, show/hide periods
  - Metric Cards: add/remove cards
- **Export / Import:** Download JSON layout or upload saved layout

### Savings Calculation

| Setting | Description |
|---------|-------------|
| **Currency Symbol** | €, $, ₦, etc. |
| **Rate per kWh** | Electricity cost (e.g. 0.30) |

---

## 🐳 Docker Hub Images

Pre‑built images available:

- **Main dashboard:** `irunmole/epilykos:latest`
- **BMS bridge (sidecar):** `irunmole/epilykos-bms:latest`

**Example `docker-compose.yml` (with BMS bridge):**

```yaml
services:
  epilykos:
    image: irunmole/epilykos:latest
    container_name: epilykos
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - SETTINGS_PASSWORD=${SETTINGS_PASSWORD}
      - TZ=Africa/Lagos
      - BMS_BRIDGE_URL=http://bms-bridge:8020
    depends_on:
      - bms-bridge
    extra_hosts:
      - "bms-bridge:host-gateway"

  bms-bridge:
    image: irunmole/epilykos-bms:latest
    container_name: bms-bridge
    restart: unless-stopped
    network_mode: host
    privileged: true
    volumes:
      - /var/run/dbus:/var/run/dbus
      - /dev:/dev:ro
```

Run `docker compose up -d` to start.

---

## 🛠️ Development / Manual Installation

Without Docker:

```bash
npm install
npm start
```

Server listens on port 3000. Database created in `./data`.

The BMS bridge requires Python 3.12+ and can be run separately:

```bash
cd bms-bridge
pip install -r requirements.txt
python bms_bridge.py
```

---

## 📁 Project Structure

```
epilykos/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
├── server.js                     # Entry point (modular)
├── modules/                      # Backend modules
│   ├── auth.js
│   ├── backup.js
│   ├── bms.js                    # BMS polling
│   ├── dashboard-config.js
│   ├── database.js
│   ├── external.js               # REST API
│   ├── grid.js
│   ├── ha.js
│   ├── history.js
│   ├── metrics.js
│   ├── metricsManager.js         # User-created metrics
│   ├── modbus.js                 # TCP + serial
│   ├── mqtt.js
│   ├── savings.js
│   ├── solar.js
│   └── utils.js
├── public/
│   ├── index.html
│   ├── style.css
│   ├── settings.html
│   ├── settings.js
│   └── js/                       # Frontend ES modules
│       ├── main.js
│       ├── api.js
│       ├── dashboard.js
│       ├── updater.js
│       ├── theme.js
│       ├── charts.js
│       ├── forecast.js
│       ├── tables.js
│       ├── grid.js
│       ├── utils.js
│       └── components/
│           ├── index.js
│           ├── flowCard.js
│           ├── forecastBanner.js
│           ├── metricCards.js
│           ├── gridCard.js
│           ├── chartPower.js
│           ├── chartEnergy.js
│           ├── savingsSummary.js
│           ├── dataTableDaily.js
│           ├── dataTableMonthly.js
│           ├── weatherBlock.js
│           └── batteryBlock.js
├── bms-bridge/                   # Python sidecar for Bluetooth BMS
│   ├── Dockerfile
│   ├── requirements.txt
│   └── bms_bridge.py
├── profiles/                     # JSON Modbus register maps
└── data/                         # SQLite database (runtime)
```

---

## ❓ Troubleshooting

### All values show zero

**Cause:** No data source enabled or incorrectly configured.

**Solution:**
- Verify at least one source (HA, MQTT, Modbus, REST, BMS) is enabled
- Check entity/topic/mapping configurations
- Use **Test** buttons in Settings
- Check logs: `docker compose logs epilykos`

### BMS scan returns "BMS bridge not reachable"

**Cause:** Bridge container not running or not accessible on port 8020.

**Solution:**
- Ensure bridge is running: `docker compose ps`
- Verify host's Bluetooth is working: `bluetoothctl`
- For remote access: scanning only works on local network

### BMS scan finds no devices

**Cause:** Device name doesn't contain "BMS", "JK", "JBD", or "Daly".

**Solution:**
- Filter can be adjusted in `bms-bridge/bms_bridge.py`
- All devices may be returned if no BMS keywords match – check the full list

### WebSocket disconnects

**Cause:** Reverse proxy not supporting WebSocket upgrade.

**Solution:**
- Ensure nginx/Traefik configured with `Upgrade` headers
- Dashboard automatically falls back to polling (60s)

### Modbus serial device not reading

**Cause:** Wrong serial path or permissions.

**Solution:**
- Verify device exists: `ls -l /dev/ttyUSB0`
- Grant permissions: `usermod -a -G dialout node` (inside container)
- For testing: set `privileged: true` in docker-compose (not recommended)

### "Metric" dropdown shows no options

**Cause:** No metrics created or fetched yet.

**Solution:**
- Go to **Metrics** tab and create a metric
- Or add a device mapping (auto-creates metrics)
- After adding, dropdowns will populate

### Login popup on main page (old Basic Auth)

**Cause:** Cached credentials from older version.

**Solution:**
- Clear browser cache and hard refresh
- Current version uses session‑based auth; main page is fully public

---

## 📖 Developer Resources

### Developer Guide

See the **[Developer Guide](docs/DEVELOPER.md)** for:
- Adding new block types
- Extending data sources
- Contributing metrics
- Custom Modbus profiles
- Building features

### Knowledge Base

See the **[Knowledge Base](docs/KNOWLEDGE_BASE.md)** for:
- Complete database schema
- All API endpoints
- Data flow architecture
- Polling and caching strategies
- Function reference

---

## 📄 License

**GNU General Public License v3.0** – see `LICENSE` file for details.

---

## 🙌 Acknowledgements

Built with:
- **Express.js** – Backend framework
- **Chart.js** – Data visualisation
- **SQLite** – Data storage
- **MQTT.js** – MQTT client
- **modbus-serial** – Modbus TCP/serial
- **ws** – WebSocket server
- **bleak** – Bluetooth BLE scanning (bridge)

Solar forecast powered by **Solcast** and **Open-Meteo**.  
Icons by **Flaticon** (uicons).

---

**Happy monitoring!** ☀️🔋🏠

For issues, suggestions, or contributions, please open an issue or pull request on [GitHub](https://github.com/yourusername/epilykos).
