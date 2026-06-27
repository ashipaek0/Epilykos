#!/bin/bash
set -e

PROJECT_DIR="energy-dashboard"
echo "Creating project in ./$PROJECT_DIR"

mkdir -p "$PROJECT_DIR"/{public,data}

# Dockerfile
cat > "$PROJECT_DIR/Dockerfile" <<'EOF'
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["npm", "start"]
EOF

# docker-compose.yml
cat > "$PROJECT_DIR/docker-compose.yml" <<'EOF'
version: '3.8'
services:
  energy-dashboard:
    build: .
    container_name: energy-dashboard
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - SETTINGS_PASSWORD=your_secure_password_here
      - HA_URL=http://homeassistant.local:8123
      - HA_TOKEN=
      - SOLAR_ASSISTANT_URL=http://solar-assistant.local
      - SOLAR_ASSISTANT_API_KEY=
EOF

# .env.example
cat > "$PROJECT_DIR/.env.example" <<'EOF'
SETTINGS_PASSWORD=change_me
HA_URL=http://homeassistant.local:8123
HA_TOKEN=
SOLAR_ASSISTANT_URL=http://solar-assistant.local
SOLAR_ASSISTANT_API_KEY=
EOF

# package.json
cat > "$PROJECT_DIR/package.json" <<'EOF'
{
  "name": "energy-dashboard",
  "version": "2.1.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "node-fetch": "^2.6.7",
    "sqlite3": "^5.1.6",
    "sqlite": "^4.2.1",
    "dotenv": "^16.0.3",
    "express-basic-auth": "^1.2.1",
    "mqtt": "^5.3.0"
  }
}
EOF

# server.js
cat > "$PROJECT_DIR/server.js" <<'EOF'
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const basicAuth = require('express-basic-auth');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 3000;

const settingsPassword = process.env.SETTINGS_PASSWORD || 'admin';
const authMiddleware = basicAuth({
  users: { 'admin': settingsPassword },
  challenge: true,
  realm: 'Energy Dashboard Settings'
});

let db;
(async () => {
  db = await open({
    filename: './data/energy.db',
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      timestamp INTEGER PRIMARY KEY,
      consumption REAL,
      solar REAL,
      battery_charge REAL,
      battery_discharge REAL,
      grid_import REAL,
      grid_export REAL,
      daily_consumption REAL,
      daily_solar REAL,
      daily_battery_charge REAL,
      daily_battery_discharge REAL,
      daily_grid_import REAL,
      daily_grid_export REAL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON history(timestamp);
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const count = await db.get('SELECT COUNT(*) as cnt FROM config');
  if (count.cnt === 0) {
    const defaults = {
      ha_url: process.env.HA_URL || '',
      ha_token: process.env.HA_TOKEN || '',
      solar_assistant_url: process.env.SOLAR_ASSISTANT_URL || '',
      solar_assistant_api_key: process.env.SOLAR_ASSISTANT_API_KEY || '',
      mqtt_broker_url: '',
      mqtt_username: '',
      mqtt_password: '',
      mqtt_topic_consumption: 'energy/consumption',
      mqtt_topic_solar: 'energy/solar',
      mqtt_topic_battery_charge: 'energy/battery/charge',
      mqtt_topic_battery_discharge: 'energy/battery/discharge',
      mqtt_topic_grid_import: 'energy/grid/import',
      mqtt_topic_grid_export: 'energy/grid/export',
      mqtt_topic_daily_consumption: 'energy/daily/consumption',
      mqtt_topic_daily_solar: 'energy/daily/solar',
      mqtt_topic_daily_battery_charge: 'energy/daily/battery_charge',
      mqtt_topic_daily_battery_discharge: 'energy/daily/battery_discharge',
      mqtt_topic_daily_grid_import: 'energy/daily/grid_import',
      mqtt_topic_daily_grid_export: 'energy/daily/grid_export',
      consumption_entity: 'sensor.total_power',
      solar_entity: 'sensor.solar_power',
      battery_charge_entity: 'sensor.battery_charge_power',
      battery_discharge_entity: 'sensor.battery_discharge_power',
      grid_import_entity: 'sensor.grid_import_power',
      grid_export_entity: 'sensor.grid_export_power',
      daily_consumption_entity: 'sensor.daily_energy',
      daily_solar_entity: 'sensor.daily_solar',
      daily_battery_charge_entity: 'sensor.daily_battery_charge',
      daily_battery_discharge_entity: 'sensor.daily_battery_discharge',
      daily_grid_import_entity: 'sensor.daily_grid_import',
      daily_grid_export_entity: 'sensor.daily_grid_export'
    };
    for (const [key, value] of Object.entries(defaults)) {
      await db.run('INSERT INTO config (key, value) VALUES (?, ?)', [key, String(value)]);
    }
  }
  console.log('Database initialized');
  setupMqtt();
})();

async function getConfig(key) {
  const row = await db.get('SELECT value FROM config WHERE key = ?', key);
  return row ? row.value : null;
}

async function setConfig(key, value) {
  await db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, String(value)]);
}

let mqttClient = null;
const mqttValues = {
  consumption: 0, solar: 0, battery_charge: 0, battery_discharge: 0,
  grid_import: 0, grid_export: 0, daily_consumption: 0, daily_solar: 0,
  daily_battery_charge: 0, daily_battery_discharge: 0,
  daily_grid_import: 0, daily_grid_export: 0
};

async function setupMqtt() {
  const brokerUrl = await getConfig('mqtt_broker_url');
  if (!brokerUrl) return;
  const options = {};
  const username = await getConfig('mqtt_username');
  const password = await getConfig('mqtt_password');
  if (username) options.username = username;
  if (password) options.password = password;
  mqttClient = mqtt.connect(brokerUrl, options);
  mqttClient.on('connect', async () => {
    console.log('MQTT connected');
    const topics = [
      await getConfig('mqtt_topic_consumption'),
      await getConfig('mqtt_topic_solar'),
      await getConfig('mqtt_topic_battery_charge'),
      await getConfig('mqtt_topic_battery_discharge'),
      await getConfig('mqtt_topic_grid_import'),
      await getConfig('mqtt_topic_grid_export'),
      await getConfig('mqtt_topic_daily_consumption'),
      await getConfig('mqtt_topic_daily_solar'),
      await getConfig('mqtt_topic_daily_battery_charge'),
      await getConfig('mqtt_topic_daily_battery_discharge'),
      await getConfig('mqtt_topic_daily_grid_import'),
      await getConfig('mqtt_topic_daily_grid_export')
    ].filter(t => t);
    mqttClient.subscribe(topics);
  });
  mqttClient.on('message', (topic, message) => {
    const value = parseFloat(message.toString());
    if (isNaN(value)) return;
    const keyMap = {
      [await getConfig('mqtt_topic_consumption')]: 'consumption',
      [await getConfig('mqtt_topic_solar')]: 'solar',
      [await getConfig('mqtt_topic_battery_charge')]: 'battery_charge',
      [await getConfig('mqtt_topic_battery_discharge')]: 'battery_discharge',
      [await getConfig('mqtt_topic_grid_import')]: 'grid_import',
      [await getConfig('mqtt_topic_grid_export')]: 'grid_export',
      [await getConfig('mqtt_topic_daily_consumption')]: 'daily_consumption',
      [await getConfig('mqtt_topic_daily_solar')]: 'daily_solar',
      [await getConfig('mqtt_topic_daily_battery_charge')]: 'daily_battery_charge',
      [await getConfig('mqtt_topic_daily_battery_discharge')]: 'daily_battery_discharge',
      [await getConfig('mqtt_topic_daily_grid_import')]: 'daily_grid_import',
      [await getConfig('mqtt_topic_daily_grid_export')]: 'daily_grid_export'
    };
    const key = keyMap[topic];
    if (key) mqttValues[key] = value;
  });
}

async function restartMqtt() {
  if (mqttClient) { mqttClient.end(); mqttClient = null; }
  setupMqtt();
}

async function getHAState(entityId) {
  const haUrl = await getConfig('ha_url');
  const haToken = await getConfig('ha_token');
  if (!haUrl || !haToken) return 0;
  const res = await fetch(`${haUrl}/api/states/${entityId}`, {
    headers: { 'Authorization': `Bearer ${haToken}` }
  });
  if (!res.ok) throw new Error(`HA API error: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.state) || 0;
}

async function getSolarData() {
  const url = await getConfig('solar_assistant_url');
  const key = await getConfig('solar_assistant_api_key');
  if (!url || !key) return null;
  const res = await fetch(`${url}/api/v1/status`, {
    headers: { 'X-Api-Key': key }
  });
  if (!res.ok) throw new Error(`Solar API error: ${res.status}`);
  return await res.json();
}

async function pollAndCache() {
  try {
    const useMqtt = !!(await getConfig('mqtt_broker_url'));
    async function getValue(mqttKey, haEntity) {
      if (useMqtt && mqttValues[mqttKey] !== undefined) return mqttValues[mqttKey];
      return await getHAState(haEntity).catch(() => 0);
    }
    const consumption = await getValue('consumption', await getConfig('consumption_entity'));
    const battCharge = await getValue('battery_charge', await getConfig('battery_charge_entity'));
    const battDischarge = await getValue('battery_discharge', await getConfig('battery_discharge_entity'));
    const gridImport = await getValue('grid_import', await getConfig('grid_import_entity'));
    const gridExport = await getValue('grid_export', await getConfig('grid_export_entity'));

    let solarPower = 0, dailySolar = 0;
    try {
      const saData = await getSolarData();
      if (saData) {
        solarPower = saData.power?.now || 0;
        dailySolar = saData.energy?.today || 0;
      } else {
        solarPower = await getValue('solar', await getConfig('solar_entity'));
        dailySolar = await getValue('daily_solar', await getConfig('daily_solar_entity'));
      }
    } catch {
      solarPower = await getValue('solar', await getConfig('solar_entity'));
      dailySolar = await getValue('daily_solar', await getConfig('daily_solar_entity'));
    }

    const dailyConsumption = await getValue('daily_consumption', await getConfig('daily_consumption_entity'));
    const dailyBattCharge = await getValue('daily_battery_charge', await getConfig('daily_battery_charge_entity'));
    const dailyBattDischarge = await getValue('daily_battery_discharge', await getConfig('daily_battery_discharge_entity'));
    const dailyGridImport = await getValue('daily_grid_import', await getConfig('daily_grid_import_entity'));
    const dailyGridExport = await getValue('daily_grid_export', await getConfig('daily_grid_export_entity'));

    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT OR REPLACE INTO history 
       (timestamp, consumption, solar, battery_charge, battery_discharge, grid_import, grid_export,
        daily_consumption, daily_solar, daily_battery_charge, daily_battery_discharge, daily_grid_import, daily_grid_export)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [now, consumption, solarPower, battCharge, battDischarge, gridImport, gridExport,
       dailyConsumption, dailySolar, dailyBattCharge, dailyBattDischarge, dailyGridImport, dailyGridExport]
    );
    console.log(`Cached at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('Polling error:', err);
  }
}

pollAndCache();
setInterval(pollAndCache, 30000);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/current', async (req, res) => {
  try {
    const latest = await db.get('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1');
    if (latest) {
      res.json({
        consumption_kw: latest.consumption / 1000,
        solar_kw: latest.solar / 1000,
        battery_charge_kw: latest.battery_charge / 1000,
        battery_discharge_kw: latest.battery_discharge / 1000,
        grid_import_kw: latest.grid_import / 1000,
        grid_export_kw: latest.grid_export / 1000,
        daily_consumption_kwh: latest.daily_consumption,
        daily_solar_kwh: latest.daily_solar,
        daily_battery_charge_kwh: latest.daily_battery_charge,
        daily_battery_discharge_kwh: latest.daily_battery_discharge,
        daily_grid_import_kwh: latest.daily_grid_import,
        daily_grid_export_kwh: latest.daily_grid_export,
        timestamp: latest.timestamp * 1000
      });
    } else {
      res.json({ error: 'No data yet' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  const days = parseInt(req.query.days) || 1;
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = await db.all(
      `SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`,
      [since]
    );
    res.json(rows.map(r => ({
      ...r,
      consumption_kw: r.consumption / 1000,
      solar_kw: r.solar / 1000,
      battery_charge_kw: r.battery_charge / 1000,
      battery_discharge_kw: r.battery_discharge / 1000,
      grid_import_kw: r.grid_import / 1000,
      grid_export_kw: r.grid_export / 1000,
      timestamp: r.timestamp * 1000
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = await db.all(`
      SELECT 
        date(timestamp, 'unixepoch') as day,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history
      WHERE timestamp >= ?
      GROUP BY day
      ORDER BY day ASC
    `, [since]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monthly', async (req, res) => {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0,7));
  }
  try {
    const rows = await db.all(`
      SELECT 
        strftime('%Y-%m', timestamp, 'unixepoch') as month,
        SUM(daily_consumption) as consumption_kwh,
        SUM(daily_solar) as solar_kwh,
        SUM(daily_battery_charge) as battery_charge_kwh,
        SUM(daily_battery_discharge) as battery_discharge_kwh,
        SUM(daily_grid_import) as grid_import_kwh,
        SUM(daily_grid_export) as grid_export_kwh
      FROM history
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);
    const result = months.map(m => {
      const found = rows.find(r => r.month === m);
      return found || {
        month: m,
        consumption_kwh: 0,
        solar_kwh: 0,
        battery_charge_kwh: 0,
        battery_discharge_kwh: 0,
        grid_import_kwh: 0,
        grid_export_kwh: 0
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/settings', authMiddleware);
app.get('/api/settings', async (req, res) => {
  const rows = await db.all('SELECT key, value FROM config');
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});
app.post('/api/settings', async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    await setConfig(key, String(value));
  }
  if ('mqtt_broker_url' in updates || 'mqtt_username' in updates || 'mqtt_password' in updates) {
    await restartMqtt();
  }
  res.json({ success: true });
});
app.get('/settings', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.listen(PORT, () => {
  console.log(`Energy dashboard running on port ${PORT}`);
});
EOF

# public/index.html
cat > "$PROJECT_DIR/public/index.html" <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Energy Monitor</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
</head>
<body>
  <div class="container">
    <header>
      <h1>⚡ Energy Dashboard</h1>
      <a href="/settings" class="settings-link">⚙️ Settings</a>
    </header>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Load</div><div class="stat-value" id="load-power">-- kW</div></div>
      <div class="stat-card"><div class="stat-label">Solar PV</div><div class="stat-value" id="solar-power">-- kW</div></div>
      <div class="stat-card"><div class="stat-label">Battery</div><div class="stat-value" id="battery-net">-- kW</div><div class="stat-sub" id="battery-detail">⚡ -- | 🔋 --</div></div>
      <div class="stat-card"><div class="stat-label">Grid</div><div class="stat-value" id="grid-net">-- kW</div><div class="stat-sub" id="grid-detail">⬇️ -- | ⬆️ --</div></div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Today's Load</div><div class="stat-value" id="daily-load">-- kWh</div></div>
      <div class="stat-card"><div class="stat-label">Today's Solar</div><div class="stat-value" id="daily-solar">-- kWh</div></div>
      <div class="stat-card"><div class="stat-label">Self-sufficiency</div><div class="stat-value" id="self-sufficiency">--%</div></div>
      <div class="stat-card"><div class="stat-label">Est. Savings</div><div class="stat-value" id="savings">-- €</div></div>
    </div>
    <div class="chart-container">
      <div class="chart-header">
        <h3>Power Overview (Last 24h)</h3>
        <div class="chart-controls">
          <button data-range="1" class="active">24h</button>
          <button data-range="7">7d</button>
          <button data-range="30">30d</button>
          <button data-range="90">90d</button>
        </div>
      </div>
      <canvas id="powerChart"></canvas>
    </div>
    <div class="table-container">
      <h3>Last 12 Months</h3>
      <div class="table-wrapper">
        <table id="monthly-table">
          <thead><tr><th></th><th>Load</th><th>Solar PV</th><th>Battery charged</th><th>Battery discharged</th><th>Grid used</th><th>Grid exported</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    <footer class="stats-footer">
      <span>Peak today: <span id="peak-today">-- kW</span></span>
      <span>Avg today: <span id="avg-today">-- kW</span></span>
    </footer>
  </div>
  <script src="script.js"></script>
</body>
</html>
EOF

# public/style.css
cat > "$PROJECT_DIR/public/style.css" <<'EOF'
:root { --bg: #0f172a; --card-bg: #1e293b; --text: #f8fafc; --accent: #3b82f6; --solar: #fbbf24; --battery: #10b981; --grid: #ef4444; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 1rem; min-height: 100vh; }
.container { max-width: 1400px; margin: 0 auto; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
h1 { font-weight: 500; }
.settings-link { color: var(--text); text-decoration: none; background: var(--card-bg); padding: 0.5rem 1rem; border-radius: 2rem; font-size: 0.9rem; }
.settings-link:hover { background: var(--accent); }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
.stat-card { background: var(--card-bg); padding: 1.2rem 0.8rem; border-radius: 1rem; text-align: center; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.3); }
.stat-label { font-size: 0.85rem; opacity: 0.8; margin-bottom: 0.5rem; }
.stat-value { font-size: 1.8rem; font-weight: 600; }
.stat-sub { font-size: 0.8rem; opacity: 0.7; margin-top: 0.25rem; }
.chart-container { background: var(--card-bg); padding: 1.5rem; border-radius: 1rem; margin-bottom: 2rem; height: 450px; position: relative; }
.chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
.chart-header h3 { font-weight: 500; }
.chart-controls { display: flex; gap: 0.5rem; }
.chart-controls button { background: #334155; border: none; color: var(--text); padding: 0.4rem 0.8rem; border-radius: 2rem; cursor: pointer; font-size: 0.8rem; transition: background 0.2s; }
.chart-controls button.active, .chart-controls button:hover { background: var(--accent); }
.table-container { background: var(--card-bg); padding: 1.5rem; border-radius: 1rem; margin-bottom: 1.5rem; }
.table-container h3 { margin-bottom: 1rem; font-weight: 500; }
.table-wrapper { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { padding: 0.75rem 0.5rem; text-align: right; border-bottom: 1px solid #334155; }
th:first-child, td:first-child { text-align: left; font-weight: 600; }
th { color: #94a3b8; font-weight: 500; }
.stats-footer { display: flex; justify-content: space-around; background: var(--card-bg); padding: 1rem; border-radius: 1rem; flex-wrap: wrap; gap: 1rem; }
@media (max-width: 600px) { .stat-value { font-size: 1.4rem; } .chart-container { height: 350px; } }
EOF

# public/script.js
cat > "$PROJECT_DIR/public/script.js" <<'EOF'
let powerChart;
const ctx = document.getElementById('powerChart').getContext('2d');
function initChart() {
  powerChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' },
      scales: { x: { type: 'time', time: { unit: 'hour' }, grid: { color: '#334155' } }, y: { title: { display: true, text: 'Power (kW)' }, grid: { color: '#334155' } } },
      plugins: { tooltip: { mode: 'index' }, legend: { labels: { color: '#f8fafc' } } }
    }
  });
}
async function updateCurrent() {
  try {
    const res = await fetch('/api/current');
    const d = await res.json();
    document.getElementById('load-power').textContent = d.consumption_kw.toFixed(2) + ' kW';
    document.getElementById('solar-power').textContent = d.solar_kw.toFixed(2) + ' kW';
    const battNet = d.battery_charge_kw - d.battery_discharge_kw;
    document.getElementById('battery-net').textContent = battNet.toFixed(2) + ' kW';
    document.getElementById('battery-detail').innerHTML = `⚡ ${d.battery_charge_kw.toFixed(2)} | 🔋 ${d.battery_discharge_kw.toFixed(2)}`;
    const gridNet = d.grid_import_kw - d.grid_export_kw;
    document.getElementById('grid-net').textContent = gridNet.toFixed(2) + ' kW';
    document.getElementById('grid-detail').innerHTML = `⬇️ ${d.grid_import_kw.toFixed(2)} | ⬆️ ${d.grid_export_kw.toFixed(2)}`;
    document.getElementById('daily-load').textContent = d.daily_consumption_kwh.toFixed(2) + ' kWh';
    document.getElementById('daily-solar').textContent = d.daily_solar_kwh.toFixed(2) + ' kWh';
    const sufficiency = d.daily_consumption_kwh > 0 ? (d.daily_solar_kwh / d.daily_consumption_kwh * 100).toFixed(1) : '0.0';
    document.getElementById('self-sufficiency').textContent = sufficiency + '%';
    document.getElementById('savings').textContent = (d.daily_solar_kwh * 0.30).toFixed(2) + ' €';
  } catch (e) { console.error(e); }
}
async function updateChart(days = 1) {
  try {
    const res = await fetch(`/api/history?days=${days}`);
    const data = await res.json();
    if (!data.length) return;
    const datasets = [
      { label: 'Load', data: [], borderColor: '#ef4444', backgroundColor: '#ef444420', tension: 0.2 },
      { label: 'Solar PV', data: [], borderColor: '#fbbf24', backgroundColor: '#fbbf2420', tension: 0.2 },
      { label: 'Battery Charge', data: [], borderColor: '#10b981', backgroundColor: '#10b98120', tension: 0.2, hidden: true },
      { label: 'Battery Discharge', data: [], borderColor: '#34d399', backgroundColor: '#34d39920', tension: 0.2, hidden: true },
      { label: 'Grid Import', data: [], borderColor: '#f87171', backgroundColor: '#f8717120', tension: 0.2, hidden: true },
      { label: 'Grid Export', data: [], borderColor: '#fca5a5', backgroundColor: '#fca5a520', tension: 0.2, hidden: true }
    ];
    data.forEach(d => {
      datasets[0].data.push({ x: d.timestamp, y: d.consumption_kw });
      datasets[1].data.push({ x: d.timestamp, y: d.solar_kw });
      datasets[2].data.push({ x: d.timestamp, y: d.battery_charge_kw });
      datasets[3].data.push({ x: d.timestamp, y: d.battery_discharge_kw });
      datasets[4].data.push({ x: d.timestamp, y: d.grid_import_kw });
      datasets[5].data.push({ x: d.timestamp, y: d.grid_export_kw });
    });
    powerChart.data.datasets = datasets;
    powerChart.update();
    const loads = data.map(d => d.consumption_kw);
    document.getElementById('peak-today').textContent = Math.max(...loads).toFixed(2) + ' kW';
    document.getElementById('avg-today').textContent = (loads.reduce((a,b)=>a+b,0)/loads.length).toFixed(2) + ' kW';
  } catch (e) { console.error(e); }
}
async function updateMonthly() {
  try {
    const res = await fetch('/api/monthly');
    const data = await res.json();
    const tbody = document.querySelector('#monthly-table tbody');
    tbody.innerHTML = '';
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    data.forEach(row => {
      const [year, month] = row.month.split('-');
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${monthNames[parseInt(month)-1]} ${year.slice(2)}</td>
        <td>${row.consumption_kwh.toFixed(1)} kWh</td><td>${row.solar_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_charge_kwh.toFixed(1)} kWh</td><td>${row.battery_discharge_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_import_kwh.toFixed(1)} kWh</td><td>${row.grid_export_kwh.toFixed(1)} kWh</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}
document.querySelectorAll('.chart-controls button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('.chart-controls .active')?.classList.remove('active');
    btn.classList.add('active');
    updateChart(parseInt(btn.dataset.range));
  });
});
initChart();
updateCurrent();
updateChart(1);
updateMonthly();
setInterval(updateCurrent, 30000);
setInterval(() => updateChart(1), 30000);
EOF

# public/settings.html
cat > "$PROJECT_DIR/public/settings.html" <<'EOF'
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Settings</title>
<link rel="stylesheet" href="style.css">
<style>
.settings-form { background: var(--card-bg); padding: 2rem; border-radius: 1rem; max-width: 800px; margin: 2rem auto; }
.form-group { margin-bottom: 1.5rem; } label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
input { width: 100%; padding: 0.75rem; background: #0f172a; border: 1px solid #334155; border-radius: 0.5rem; color: var(--text); font-size: 1rem; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
button { background: var(--accent); color: white; border: none; padding: 0.75rem 2rem; border-radius: 0.5rem; font-size: 1rem; cursor: pointer; }
.back-link { display: inline-block; margin-bottom: 1rem; color: var(--accent); text-decoration: none; }
.status { margin-top: 1rem; padding: 0.5rem; border-radius: 0.5rem; } .success { background: #10b98120; color: #10b981; } .error { background: #ef444420; color: #ef4444; }
</style>
</head>
<body><div class="container"><a href="/" class="back-link">← Back to Dashboard</a><div class="settings-form"><h2>Configuration</h2>
<form id="settings-form">
<h3>Home Assistant</h3><div class="form-group"><label>URL</label><input type="url" name="ha_url" required></div>
<div class="form-group"><label>Token</label><input type="password" name="ha_token" required></div>
<h3>Solar Assistant</h3><div class="form-group"><label>URL</label><input type="url" name="solar_assistant_url"></div>
<div class="form-group"><label>API Key</label><input type="password" name="solar_assistant_api_key"></div>
<h3>MQTT</h3><div class="form-group"><label>Broker URL</label><input type="text" name="mqtt_broker_url" placeholder="mqtt://broker.local:1883"></div>
<div class="form-row"><div class="form-group"><label>Username</label><input type="text" name="mqtt_username"></div><div class="form-group"><label>Password</label><input type="password" name="mqtt_password"></div></div>
<h4>MQTT Topics (W)</h4>
<div class="form-row"><div class="form-group"><label>Consumption</label><input name="mqtt_topic_consumption"></div><div class="form-group"><label>Solar PV</label><input name="mqtt_topic_solar"></div></div>
<div class="form-row"><div class="form-group"><label>Battery Charge</label><input name="mqtt_topic_battery_charge"></div><div class="form-group"><label>Battery Discharge</label><input name="mqtt_topic_battery_discharge"></div></div>
<div class="form-row"><div class="form-group"><label>Grid Import</label><input name="mqtt_topic_grid_import"></div><div class="form-group"><label>Grid Export</label><input name="mqtt_topic_grid_export"></div></div>
<h4>MQTT Daily Topics (kWh)</h4>
<div class="form-row"><div class="form-group"><label>Daily Consumption</label><input name="mqtt_topic_daily_consumption"></div><div class="form-group"><label>Daily Solar</label><input name="mqtt_topic_daily_solar"></div></div>
<div class="form-row"><div class="form-group"><label>Daily Batt Charge</label><input name="mqtt_topic_daily_battery_charge"></div><div class="form-group"><label>Daily Batt Discharge</label><input name="mqtt_topic_daily_battery_discharge"></div></div>
<div class="form-row"><div class="form-group"><label>Daily Grid Import</label><input name="mqtt_topic_daily_grid_import"></div><div class="form-group"><label>Daily Grid Export</label><input name="mqtt_topic_daily_grid_export"></div></div>
<h3>Home Assistant Entity IDs</h3>
<div class="form-row"><div class="form-group"><label>Consumption (W)</label><input name="consumption_entity" value="sensor.total_power"></div><div class="form-group"><label>Solar PV (W)</label><input name="solar_entity" value="sensor.solar_power"></div></div>
<div class="form-row"><div class="form-group"><label>Battery Charge (W)</label><input name="battery_charge_entity" value="sensor.battery_charge_power"></div><div class="form-group"><label>Battery Discharge (W)</label><input name="battery_discharge_entity" value="sensor.battery_discharge_power"></div></div>
<div class="form-row"><div class="form-group"><label>Grid Import (W)</label><input name="grid_import_entity" value="sensor.grid_import_power"></div><div class="form-group"><label>Grid Export (W)</label><input name="grid_export_entity" value="sensor.grid_export_power"></div></div>
<h4>Daily Energy Entities (kWh)</h4>
<div class="form-row"><div class="form-group"><label>Daily Consumption</label><input name="daily_consumption_entity" value="sensor.daily_energy"></div><div class="form-group"><label>Daily Solar</label><input name="daily_solar_entity" value="sensor.daily_solar"></div></div>
<div class="form-row"><div class="form-group"><label>Daily Battery Charge</label><input name="daily_battery_charge_entity" value="sensor.daily_battery_charge"></div><div class="form-group"><label>Daily Battery Discharge</label><input name="daily_battery_discharge_entity" value="sensor.daily_battery_discharge"></div></div>
<div class="form-row"><div class="form-group"><label>Daily Grid Import</label><input name="daily_grid_import_entity" value="sensor.daily_grid_import"></div><div class="form-group"><label>Daily Grid Export</label><input name="daily_grid_export_entity" value="sensor.daily_grid_export"></div></div>
<button type="submit">Save Settings</button><div id="status" class="status"></div>
</form></div></div>
<script src="settings.js"></script></body></html>
EOF

# public/settings.js
cat > "$PROJECT_DIR/public/settings.js" <<'EOF'
const form = document.getElementById('settings-form');
const statusDiv = document.getElementById('status');
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    for (const [key, value] of Object.entries(data)) {
      const input = form.querySelector(`[name="${key}"]`);
      if (input) input.value = value;
    }
  } catch (e) { showStatus('Failed to load settings', 'error'); }
}
function showStatus(msg, type) {
  statusDiv.textContent = msg; statusDiv.className = `status ${type}`;
  setTimeout(() => statusDiv.textContent = '', 3000);
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  try {
    const res = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    if (res.ok) showStatus('Settings saved!', 'success');
    else showStatus('Failed to save', 'error');
  } catch (e) { showStatus('Error: '+e.message, 'error'); }
});
loadSettings();
EOF

# README.md
cat > "$PROJECT_DIR/README.md" <<'EOF'
# Energy Dashboard with MQTT Support

Self-hosted energy monitor integrating Home Assistant, Solar Assistant, and MQTT.

## Quick Start
1. Set `SETTINGS_PASSWORD` in `docker-compose.yml`.
2. Run `docker-compose up -d --build`
3. Access `http://server:3000` (public) and `/settings` (protected, user `admin` + password).

## Configuration
All settings are stored in SQLite and editable via the settings UI. MQTT is optional – if configured, values will override Home Assistant for real-time data.
EOF

echo "Project created in ./$PROJECT_DIR"
echo "Run: cd $PROJECT_DIR && docker-compose up -d --build"
