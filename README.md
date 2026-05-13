# ⚡ Energy Dashboard

A self‑hosted, real‑time energy monitoring dashboard that integrates with **Home Assistant**, **MQTT**, and **Modbus TCP**. Designed for public displays – no login required for viewing, while settings are password‑protected.

<img width="1491" height="883" alt="Screenshot From 2026-05-02 14-55-31" src="https://github.com/user-attachments/assets/0511a0ba-f08c-4f72-918a-59945d3ee456" />
<img width="1460" height="803" alt="Screenshot From 2026-05-02 14-56-37" src="https://github.com/user-attachments/assets/d0599cd5-bfd0-45e0-89e0-d8e291e31a0b" />
<img width="1460" height="703" alt="Screenshot From 2026-05-02 14-57-02" src="https://github.com/user-attachments/assets/35f69b77-0695-48d4-b1d8-9cb9481990d7" />
<img width="1506" height="956" alt="Screenshot From 2026-05-02 15-04-10" src="https://github.com/user-attachments/assets/0fdc6430-fbcf-438d-9074-f466fe92b363" />
<img width="1506" height="956" alt="Screenshot From 2026-05-02 15-04-41" src="https://github.com/user-attachments/assets/6498c54d-119e-4754-a2d1-2f672d1624d1" />
<img width="1506" height="956" alt="Screenshot From 2026-05-02 15-04-23" src="https://github.com/user-attachments/assets/655d143e-f1c2-4bd5-8ff2-39333b9e0f16" />

> **Multi‑source, multi‑device, infinitely customisable.** Monitor your energy in real time across any combination of Home Assistant instances, MQTT brokers, and Modbus inverters.

---

## ✨ Features

### 📊 Live Data & Flow Visualisation

- **Animated Flow Card** – Colour‑coded arrows show power flowing between **Solar**, **Battery**, **Home**, and **Grid**. Icons change colour based on activity.
- **Real‑time Stats** – Current power (W), battery state of charge (%), daily totals (kWh), self‑sufficiency, and cost savings.
- **Solar Forecast Banner** – Predicts solar generation for the next 4 days using high‑accuracy **Solcast** (with API key) or free **Open‑Meteo** as fallback. Includes hourly sparkline chart, weather summary, and daily prediction cards.
- **Grid Status & Timeline** – Current grid state (ON/OFF), uptime hours (day/week/month/year), and a 24‑hour timeline bar with hover tooltips showing exact change timestamps.

### 🎨 Modular Dashboard Design

- **Multiple tabs** – Create separate dashboard tabs (e.g. "Main", "Technical", "Living Room"). Each tab has its own custom layout.
- **Drag‑and‑drop blocks** – Reorder blocks directly from the Settings page. Available block types:
  - Flow Card
  - Solar Forecast Banner
  - Metric Cards (custom stat cards)
  - Grid Card
  - Power Overview Chart
  - Daily Energy Bar Chart
  - Savings Summary
  - Last 30 Days Table
  - Last 12 Months Table
- **Custom metric cards** – Define any number of stat cards with title, metric name, and unit. Values update live from your data sources.
- **Developer‑friendly API** – Adding new block types requires only a few lines of JavaScript (see the project wiki for a guide).

### 🔌 Multiple Data Sources

- **Home Assistant (multi‑device)** – Add multiple HA instances with separate URLs, tokens, and entity mappings.
- **MQTT (multi‑broker)** – Connect to multiple MQTT brokers simultaneously. Map any topic to any metric name.
- **Modbus TCP** – Directly poll inverters and meters. Device profiles included for:
  - SRNE
  - Growatt
  - Deye
  - Victron
  - Voltronic
  - …and more (easily extensible)
- **Dynamic metric mapping** – Define any metric names you want (e.g. `grid_voltage`, `inverter_temp`). A built‑in tooltip shows which metrics are used by your current dashboard.

### 📈 Charts & Data Tables

- **Power Overview Chart** (24h line chart) – Load, Solar PV, Battery Charge, and Grid Import with smooth gradient fills.
- **Daily Energy Bar Chart** – Solar generated, grid imported, and energy consumed for the last 7 days.
- **Collapsible data tables**:
  - **Last 30 Days** – Daily totals for load, solar, battery charge/discharge, grid import/export.
  - **Last 12 Months** – Monthly energy breakdown.

### 🎛️ Customisation & Management

- **Light / Dark mode** – Manual toggle or auto‑sync with system preference.
- **Branding** – Customise dashboard title and logo.
- **Savings calculation** – Enter your electricity rate and currency symbol.
- **Backup & Restore** – Download the entire SQLite database and restore it anytime.
- **Connection testing** – Verify MQTT brokers, topics, and solar forecasts from the settings page.
- **Responsive design** – Optimised for desktop, tablet, and mobile.

---

## 🚀 Quick Start (Docker Compose)

### 1. Clone the Repository

```bash
git clone https://github.com/ashipaek0/energy-dashboard.git
cd energy-dashboard
```

### 2. Create Environment File

```bash
cp .env.example .env
nano .env   # edit SETTINGS_PASSWORD to a strong password
```

*The `.env` file is excluded from version control and keeps your password secure.*

### 3. Start the Container

```bash
docker compose up -d --build
```

The dashboard is now available at `http://localhost:3000`.

### 4. Configure Data Sources

1. Open `http://your-ip:3000/settings`
2. Log in with username `admin` and the password from your `.env` file.
3. **Add Home Assistant device:**
   - Enter name, URL (e.g. `http://homeassistant.local:8123`), and a Long‑Lived Access Token.
   - Click **Fetch Entities** to load all available sensors.
   - Map metric names (e.g. `solar`, `battery_charge`) to entity IDs.
4. **Optionally add MQTT brokers** and Modbus devices:
   - Enter broker URL, username, and password.
   - Map topics to metric names.
5. **Set up Solar Forecast** (optional):
   - Enter latitude, longitude, system capacity, and (optionally) a Solcast API key.
   - Click **Test Forecast** to verify.
6. Click **Save All Settings**.

The dashboard will immediately begin displaying live data.

---

## 🔧 Configuration Reference

### Home Assistant (Multi‑Device)

| Setting | Description |
|---------|-------------|
| **Name** | Friendly label for this HA instance |
| **URL** | Home Assistant address (e.g. `http://homeassistant.local:8123`) |
| **Token** | Long‑Lived Access Token (generate in HA profile → Security) |
| **Poll interval** | Seconds between data fetches (default: 30) |
| **Entity mappings** | Map metric names (e.g. `solar`) to entity IDs (e.g. `sensor.srne_pv_power`) |
| **Fetch Entities** | Auto‑populate dropdown menus with your HA sensors |
| **+ Add Metric Mapping** | Create custom metric names; a tooltip shows which ones your dashboard needs |

### MQTT (Multi‑Broker)

| Setting | Description |
|---------|-------------|
| **Broker URL** | `mqtt://your-broker:1883` or `mqtt+tls://...` |
| **Username / Password** | Optional authentication |
| **Topic mappings** | Map metric names (e.g. `consumption`) to MQTT topics (e.g. `energy/load`) |
| **Test Broker** | Verify connection before saving |
| **Test Topic** | Confirm a topic is being received |

### Modbus TCP

| Setting | Description |
|---------|-------------|
| **Profile** | Pre‑defined register maps (SRNE, Growatt, Deye, Victron, etc.) |
| **Host** | IP address of the Modbus device |
| **Port** | Port number (default: 502) |
| **Unit ID** | Slave ID / Unit ID (typically 1) |
| **Poll interval** | How often to read registers (seconds) |

### Solar Forecast

| Setting | Description |
|---------|-------------|
| **Enable** | Toggle solar predictions on/off |
| **Latitude / Longitude** | Geographic position of your panels |
| **Tilt / Azimuth** | Panel angles (degrees) |
| **System Capacity (kWp)** | Total peak power (e.g. 5.0 for 5 kW system) |
| **Solcast API Key** | Optional; enables high‑accuracy forecasts. Falls back to Open‑Meteo if empty |
| **Loss Factor** | Inverter and wiring losses (0–1, default 0.9) |
| **Installation date** | Used for degradation calculations (Solcast only) |

### Dashboard Layout

Each tab contains a list of **blocks**:

1. **Add/remove blocks** using the + and ✕ buttons.
2. **Change block type** – select from Flow Card, Metric Cards, Grid Card, Charts, Tables, etc.
3. **For Metric Cards** – add/remove individual stat cards with title, metric name, and unit.
4. Click **Save All Settings** to persist all changes.

### Savings Calculation

| Setting | Description |
|---------|-------------|
| **Currency Symbol** | (e.g. €, $, ₦) |
| **Rate per kWh** | Your electricity cost (e.g. 0.30) |

---

## 🐳 Docker Hub Image

A pre‑built image is available:

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

If you prefer to run without Docker:

```bash
npm install
npm start
```

The server listens on port 3000. A SQLite database is created in `./data`.

---

## 📁 Project Structure

```
energy-dashboard/
├── Dockerfile
├── docker-compose.yml
├── .env.example               # Template for environment variables
├── .gitignore
├── package.json
├── server.js                  # Express backend, polling, aggregated API
├── public/
│   ├── index.html             # Minimal HTML shell
│   ├── script.js              # Dashboard logic, block builders, charts
│   ├── style.css              # Theme, layout, responsive styles
│   ├── settings.html          # Configuration UI
│   └── settings.js            # Settings logic, device editors, layout editor
├── profiles/                  # JSON Modbus register maps
├── data/                      # SQLite database (created at runtime)
└── README.md
```

---

## 🔒 Security

✅ **Password‑protected settings** – Basic Auth on all state‑changing endpoints  
✅ **Rate limiting** – Prevents brute‑force attacks on authenticated routes  
✅ **CSRF protection** – State‑changing requests require a custom header  
✅ **SSRF‑safe** – User provides URLs and tokens explicitly; no blind redirects  
✅ **Database rollback** – Backup created before restore; reverts on failure  
✅ **Non‑root container** – Runs as `node` user, not root  
✅ **No code injection** – No use of `eval()` or dynamic code execution  

---

## ❓ Troubleshooting

### All values show zero

**Likely cause:** No data source enabled or incorrectly mapped.

**Solution:**
- Check that at least one Home Assistant device, MQTT broker, or Modbus device is enabled.
- Verify entity/topic mappings are correct.
- Use the **Test** buttons in Settings to validate connections.
- Check server logs: `docker compose logs energy-dashboard`

### Solar / savings values stuck

**Likely cause:** `daily_solar` metric not being updated.

**Solution:**
- The dashboard computes daily solar from historical data. Ensure the solar power entity is mapped correctly.
- Verify the backend is polling the data source.
- Check server logs for polling errors.

### Grid timeline not appearing

**Likely cause:** No `grid_status` entity configured.

**Solution:**
- Add a binary sensor entity ID in **Settings** → **Home Assistant device** (or global settings).
- Save settings and wait for the next poll cycle.

### Solar forecast not appearing

**Likely cause:** Forecast disabled or missing coordinates.

**Solution:**
- Enable the forecast checkbox in Settings.
- Fill in latitude, longitude, and system capacity (kWp).
- Click **Test Forecast** to verify the configuration.
- If using Solcast, ensure your API key is valid and you have remaining calls.

### Login popup appears on main page

**Likely cause:** Cached old credentials.

**Solution:**
- Clear your browser cache.
- Test in incognito/private mode.
- Ensure `.env` SETTINGS_PASSWORD is set correctly.

### Slow tab switching or unresponsive UI

**Likely cause:** Too many individual API calls per poll cycle.

**Solution:**
- Ensure you're using the latest version of `script.js` and `server.js`.
- The latest version uses a single aggregated API endpoint.
- Reduce the number of data sources or increase poll intervals if needed.

---

## 📖 Adding a New Block Type (Developer Guide)

To create a custom block type:

1. **Add a builder function** in `public/script.js`:
   ```javascript
   function buildMyCustomBlock(data) {
     const block = document.createElement('div');
     block.className = 'dashboard-block';
     block.innerHTML = `<h3>My Block</h3><p>${data.value}</p>`;
     return block;
   }
   ```

2. **Register the block type** in `public/settings.js` (inside the block-type dropdown):
   ```javascript
   <option value="my-custom-block">My Custom Block</option>
   ```

3. **Add an update function** that populates the block from the aggregated state:
   ```javascript
   updateMyCustomBlock(element, state) {
     element.querySelector('p').textContent = state.my_custom_metric;
   }
   ```

4. **Add CSS** in `style.css` to style your block.

5. **(Optional)** Add the block to the default layout in `server.js` (inside `defaultConfig.layout`).

For a detailed guide, see the **[Developer Guide](docs/DEVELOPER.md)** (or add to your docs folder).

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
- **modbus-serial** – Modbus TCP client

Solar forecast powered by **Solcast** and **Open‑Meteo**.  
Icons by **Flaticon** (uicons).

---

**Happy monitoring!** ☀️🔋🏠

For issues, suggestions, or contributions, please open an issue or pull request on [GitHub](https://github.com/ashipaek0/energy-dashboard).
