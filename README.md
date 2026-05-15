# ⚡ Epilykos

A self‑hosted, real‑time energy monitoring dashboard that integrates with **Home Assistant**, **MQTT**, **Modbus TCP/Serial**, and **any REST API**. Designed for public displays – no login required for viewing, while settings are password‑protected.

![Screenshot 1](https://github.com/user-attachments/assets/0511a0ba-f08c-4f72-918a-59945d3ee456)
![Screenshot 2](https://github.com/user-attachments/assets/d0599cd5-bfd0-45e0-89e0-d8e291e31a0b)
![Screenshot 3](https://github.com/user-attachments/assets/35f69b77-0695-48d4-b1d8-9cb9481990d7)
![Screenshot 4](https://github.com/user-attachments/assets/0fdc6430-fbcf-438d-9074-f466fe92b363)
![Screenshot 5](https://github.com/user-attachments/assets/6498c54d-119e-4754-a2d1-2f672d1624d1)
![Screenshot 6](https://github.com/user-attachments/assets/655d143e-f1c2-4bd5-8ff2-39333b9e0f16)

> **Multi‑source, multi‑device, infinitely customisable.** Monitor your energy in real time across any combination of Home Assistant instances, MQTT brokers, Modbus devices (TCP or serial), and external REST APIs.

---

## ✨ Features

### 📊 Live Data & Flow Visualisation

- **Animated Flow Card** – Colour‑coded arrows show power flowing between **Solar**, **Battery**, **Home**, and **Grid**. Icons change colour based on activity.
- **Real‑time Stats** – Current power (W), battery state of charge (%), daily totals (kWh), self‑sufficiency, and cost savings.
- **Solar Forecast Banner** – Predicts solar generation for the next 4 days using high‑accuracy **Solcast** (with API key) or free **Open‑Meteo** as fallback. Includes hourly sparkline, weather summary, and daily predictions.
- **Grid Status & Timeline** – Current grid state (ON/OFF), uptime hours (day/week/month/year), and a 24‑hour timeline bar with hover tooltips. Displays when the current state began (e.g. "ON since 2:30 PM").

### 🎨 Modular Dashboard Design

- **Multiple tabs** – Create separate dashboard tabs (e.g. "Main", "Technical", "Living Room") with custom layouts
- **Drag‑and‑drop blocks** – Reorder blocks directly from Settings. Available types:
  - Flow Card
  - Solar Forecast Banner
  - Metric Cards (custom stat cards)
  - Grid Card
  - Power Overview Chart
  - Daily Energy Bar Chart
  - Savings Summary
  - Last 30 Days Table
  - Last 12 Months Table

- **Per‑block configuration** – Customise individual blocks:
  - **Charts:** Title and dataset visibility (load, solar, battery, grid)
  - **Flow Card:** Toggle solar gauge
  - **Grid Card:** Toggle timeline bar
  - More options coming in future releases

- **Custom metric cards** – Add unlimited stat cards with title, metric name, and unit. Live updates from all data sources.
- **Export / Import layouts** – Share dashboard configurations as JSON

### 🔌 Multiple Data Sources

- **Home Assistant (multi‑device)** – Multiple instances, each with own URL, token, and entity mappings
- **MQTT (multi‑broker)** – Multiple brokers with flexible topic-to-metric mapping
- **Modbus TCP & Serial** – Direct polling with included profiles for SRNE, Growatt, Deye, Victron, Voltronic, and more
- **External REST APIs** – Poll any HTTP endpoint and map JSON paths to metrics. Perfect for weather, tariffs, or custom sensors
- **Dynamic metric mapping** – Define any metric names (e.g. `grid_voltage`, `inverter_temp`). Built-in tooltip shows **all** available metrics in the database

### 📈 Interactive Charts & Tables

- **Power Overview Chart** – Line chart with range selector (24h / 7d / 30d / 90d). Filter datasets and smooth gradients
- **Daily Energy Bar Chart** – Range selector (7d / 30d / 90d) for solar, grid import, consumption
- **Collapsible data tables:**
  - **Last 30 Days** – Daily totals
  - **Last 12 Months** – Monthly breakdown

### 🎛️ Customisation & Management

- **Light / Dark mode** – Manual toggle or system auto-sync
- **Branding** – Custom title and logo
- **Savings calculation** – Electricity rate and currency
- **Backup & Restore** – Download/upload entire database
- **Layout Export / Import** – Share JSON files with others
- **Connection testing** – Verify all data sources from Settings
- **Responsive design** – Desktop, tablet, and mobile optimised

### ⚡ Real‑Time Updates (WebSocket)

- **Near‑instant refresh** – Persistent WebSocket connection pushes data immediately after each poll (every 30s)
- **Automatic fallback** – Falls back to polling (60s) if WebSocket fails
- **Zero-latency updates** – No browser lag or manual refreshes needed

---

## 🚀 Quick Start (Docker Compose)

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/energy-dashboard.git
cd energy-dashboard
```

### 2. Create Environment File

```bash
cp .env.example .env
nano .env   # Edit SETTINGS_PASSWORD to a strong password
```

The `.env` file is excluded from version control and keeps your password secure.

### 3. Start the Container

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
- **Metric Cards:** Add/remove cards with title, metric, unit
- **Export / Import:** Download JSON layout or upload saved layout

### Savings Calculation

| Setting | Description |
|---------|-------------|
| **Currency Symbol** | €, $, ₦, etc. |
| **Rate per kWh** | Electricity cost (e.g. 0.30) |

---

## 🐳 Docker Hub Image

Pre‑built image available:

```
irunmole/energy-dashboard:latest
```

**Example `docker-compose.yml`:**

```yaml
services:
  energy-dashboard:
    image: irunmole/energy-dashboard:latest
    container_name: energy-dashboard
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - SETTINGS_PASSWORD=${SETTINGS_PASSWORD}
      - TZ=Africa/Lagos
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

---

## 📁 Project Structure

```
energy-dashboard/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
├── server.js                     # Entry point (modular)
├── modules/                      # Backend modules
│   ├── auth.js
│   ├── backup.js
│   ├── dashboard-config.js
│   ├── database.js
│   ├── external.js               # REST API sources
│   ├── grid.js
│   ├── ha.js
│   ├── history.js
│   ├── metrics.js
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
│           └── dataTableMonthly.js
├── profiles/                     # JSON Modbus register maps
└── data/                         # SQLite database (runtime)
```

---

## 🔒 Security

✅ **Password‑protected settings** – Basic Auth on all state‑changing endpoints  
✅ **Rate limiting** – 10 requests/minute on authenticated routes  
✅ **CSRF protection** – Custom header required for non-GET requests  
✅ **SSRF prevention** – User provides URLs explicitly; no blind redirects  
✅ **Database rollback** – Automatic backup before restore; reverts on failure  
✅ **Non‑root container** – Runs as `node` user  
✅ **No code injection** – No `eval()`; all inputs validated  

---

## ❓ Troubleshooting

### All values show zero

**Cause:** No data source enabled or incorrectly configured.

**Solution:**
- Verify at least one source (HA, MQTT, Modbus, or REST API) is enabled
- Check entity/topic/mapping configurations
- Use **Test** buttons in Settings
- Check logs: `docker compose logs energy-dashboard`

### Solar / Savings values stuck

**Cause:** `daily_solar` metric not updating.

**Solution:**
- Dashboard computes daily solar from history. Verify solar entity is mapped
- Confirm backend is polling the source
- Check logs for errors

### Grid timeline not appearing

**Cause:** No `grid_status` entity configured.

**Solution:**
- Add binary sensor entity ID in Settings → Home Assistant
- Save and wait for next poll cycle
- Timeline appears after first state change is recorded

### Solar forecast not appearing

**Cause:** Forecast disabled or missing coordinates.

**Solution:**
- Enable forecast checkbox
- Fill latitude, longitude, system capacity
- Click **Test Forecast**
- If using Solcast, verify API key validity and remaining calls

### WebSocket disconnects

**Cause:** Reverse proxy not supporting WebSocket upgrade.

**Solution:**
- Ensure nginx/Traefik configured with `Upgrade` headers
- Dashboard automatically falls back to polling (60s)
- Check proxy logs for upgrade failures

### Modbus serial device not reading

**Cause:** Wrong serial path or permissions.

**Solution:**
- Verify device exists: `ls -l /dev/ttyUSB0`
- Grant permissions: `usermod -a -G dialout node` (inside container)
- For testing: set `privileged: true` in docker-compose (not recommended)

### Login popup on main page

**Cause:** Cached credentials or auth misconfiguration.

**Solution:**
- Clear browser cache
- Test in incognito mode
- Verify `.env SETTINGS_PASSWORD` is set

### Slow UI or unresponsive dashboard

**Cause:** Too many individual API calls or old version.

**Solution:**
- Latest version uses aggregated endpoint + WebSocket
- Upgrade to latest version
- Reduce data sources or increase poll intervals if needed

---

## 📖 Developer Guide

See the **[Developer Guide](docs/DEVELOPER.md)** for detailed instructions on:

- Adding new block types
- Extending data sources
- Contributing metrics
- Custom Modbus profiles
- Building features

---

## 📊 Architecture & Knowledge Base

For developers and maintainers, see the **[Knowledge Base](docs/KNOWLEDGE_BASE.md)** which documents:

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

Solar forecast powered by **Solcast** and **Open-Meteo**.  
Icons by **Flaticon** (uicons).

---

**Happy monitoring!** ☀️🔋🏠

For issues, suggestions, or contributions, please open an issue or pull request on [GitHub](https://github.com/yourusername/energy-dashboard).
