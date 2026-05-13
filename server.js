require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');
const basicAuth = require('express-basic-auth');
const mqtt = require('mqtt');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const ModbusRTU = require('modbus-serial');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Security ──────────────────────────────────
let settingsPassword = process.env.SETTINGS_PASSWORD;
if (!settingsPassword) {
  settingsPassword = crypto.randomBytes(8).toString('hex');
  console.warn('⚠️  No SETTINGS_PASSWORD, using random: ' + settingsPassword);
}
const authMiddleware = basicAuth({ users: { 'admin': settingsPassword }, challenge: true, realm: 'Energy Dashboard Settings' });
const authLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: 'Too many requests' } });
app.use('/settings', authLimiter);
app.use('/api/settings', authLimiter);
app.use('/api/backup', authLimiter);
app.use('/api/restore', authLimiter);
app.use('/api/test-mqtt', authLimiter);
app.use('/api/test-mqtt-topic', authLimiter);
app.use('/api/test-forecast', authLimiter);
app.use('/api/ha-device-entities', authLimiter);
app.use('/api/modbus/profiles', authLimiter);
app.use('/api/test-modbus', authLimiter);
app.use('/api/dashboard-config', authLimiter);

const csrfProtection = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!req.headers['x-requested-with'] || req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'CSRF protection: Missing X-Requested-With header' });
    }
  }
  next();
};
app.use('/api', csrfProtection);

const upload = multer({ dest: '/tmp/', fileFilter: (req, file, cb) => file.originalname.endsWith('.db') ? cb(null, true) : cb(new Error('Only .db files')), limits: { fileSize: 50*1024*1024 } });

let db;
const DB_PATH = './data/energy.db';
const mqttClients = new Map();

// ── Database init ─────────────────────────────
function initializeDatabase() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`CREATE TABLE IF NOT EXISTS history (timestamp INTEGER PRIMARY KEY, consumption REAL, solar REAL, battery_charge REAL, battery_discharge REAL, grid_import REAL, grid_export REAL, battery_soc REAL, daily_consumption REAL, daily_solar REAL, daily_battery_charge REAL, daily_battery_discharge REAL, daily_grid_import REAL, daily_grid_export REAL); CREATE INDEX IF NOT EXISTS idx_timestamp ON history(timestamp);`);
  db.exec(`CREATE TABLE IF NOT EXISTS grid_status (timestamp INTEGER PRIMARY KEY, state INTEGER);`);
  db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS metrics (timestamp INTEGER NOT NULL, metric TEXT NOT NULL, value REAL, PRIMARY KEY (timestamp, metric));`);
  db.exec(`CREATE TABLE IF NOT EXISTS latest_metrics (metric TEXT PRIMARY KEY, value REAL, timestamp INTEGER);`);

  const essentialKeys = ['ha_devices','mqtt_devices','modbus_devices','dashboard_config','solar_latitude','solar_longitude','solar_tilt','solar_azimuth','solar_capacity_kwp','solcast_api_key','forecast_enabled','solar_loss_factor','solar_install_date','solcast_resource_id','savings_currency','savings_rate','dashboard_title','dashboard_logo','grid_status_entity','all_time_pv_savings_override'];
  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  essentialKeys.forEach(k => insertConfig.run(k, ''));
  const defaults = { forecast_enabled:'false', dashboard_title:'⚡ Energy Dashboard', savings_currency:'€', savings_rate:'0.30', solar_loss_factor:'0.9', solar_install_date: new Date().toISOString().split('T')[0] };
  const updateConfig = db.prepare('UPDATE config SET value = ? WHERE key = ? AND value = ?');
  Object.entries(defaults).forEach(([k,v]) => updateConfig.run(v, k, ''));

  migrateLegacyConfig();
  console.log('Database initialized');
  setupMqtt();
}

function migrateLegacyConfig() {
  const haDevicesStr = getConfig('ha_devices');
  if (!haDevicesStr || JSON.parse(haDevicesStr||'[]').length === 0) {
    const haUrl = getConfig('ha_url'), haToken = getConfig('ha_token'), haEnabled = getConfig('ha_enabled')==='true';
    if (haUrl || haToken) {
      const entities = {};
      ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc','daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export','battery_voltage','inverter_temp','solar_voltage','load_power'].forEach(m => { const e = getConfig('ha_entity_'+m); if(e) entities[m]=e; });
      setConfig('ha_devices', JSON.stringify([{ name:'Home Assistant', url:haUrl, token:haToken, enabled:haEnabled, poll_interval:30, entities }]));
      db.prepare("DELETE FROM config WHERE key LIKE 'ha_entity_%' OR key IN ('ha_url','ha_token','ha_enabled')").run();
    }
  }
  const mqttDevicesStr = getConfig('mqtt_devices');
  if (!mqttDevicesStr || JSON.parse(mqttDevicesStr||'[]').length === 0) {
    const brokerUrl = getConfig('mqtt_broker_url');
    if (brokerUrl) {
      const topics = {};
      ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc','daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export','battery_voltage','inverter_temp','solar_voltage','load_power'].forEach(m => { const t = getConfig('mqtt_topic_'+m); if(t) topics[m]=t; });
      setConfig('mqtt_devices', JSON.stringify([{ name:'MQTT Broker', broker:brokerUrl, username:getConfig('mqtt_username'), password:getConfig('mqtt_password'), enabled:getConfig('mqtt_enabled')==='true', topics }]));
      db.prepare("DELETE FROM config WHERE key LIKE 'mqtt_topic_%' OR key IN ('mqtt_broker_url','mqtt_username','mqtt_password','mqtt_enabled')").run();
    }
  }
}

initializeDatabase();

// ── Modbus profiles ──────────────────────────
const profilesDir = path.join(__dirname, 'profiles');
const availableProfiles = [];
function loadProfiles() {
  if (!fs.existsSync(profilesDir)) { fs.mkdirSync(profilesDir, { recursive: true }); return; }
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
  availableProfiles.length = 0;
  files.forEach(file => {
    try {
      const raw = fs.readFileSync(path.join(profilesDir, file), 'utf8');
      const profile = JSON.parse(raw);
      availableProfiles.push({ id: file.replace('.json',''), name: profile.name || file, registers: profile.registers || [] });
    } catch(e) { console.error(`Profile error ${file}:`, e.message); }
  });
}
loadProfiles();

// ── Helpers ──────────────────────────────────
function getConfig(key) { const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key); return row ? row.value : ''; }
function setConfig(key, value) { db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value)); }
function parseGridState(state) {
  if (state === null || state === undefined) return 0;
  if (typeof state === 'number') return state > 0 ? 1 : 0;
  const str = String(state).toLowerCase().trim();
  return ['on','true','1','open','unlocked'].includes(str) ? 1 : 0;
}

const mqttValues = {};

// ── Polling functions ────────────────────────
async function pollHomeAssistant() {
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  if (!haDevices.length) return;
  const insert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const upsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  for (const device of haDevices) {
    if (!device.enabled || !device.url || !device.token) continue;
    for (const [metric, entityId] of Object.entries(device.entities)) {
      if (!entityId) continue;
      try {
        const res = await fetch(`${device.url}/api/states/${entityId}`, { headers: { Authorization: `Bearer ${device.token}` }, timeout: 5000 });
        if (!res.ok) throw new Error(`HA error ${res.status}`);
        const data = await res.json();
        const val = parseFloat(data.state);
        if (isNaN(val)) continue;
        const now = Math.floor(Date.now()/1000);
        insert.run(now, metric, val);
        upsert.run(metric, val, now);
        mqttValues[metric] = val;
      } catch(e) {}
    }
  }
}

function setupMqtt() {
  for (const [url, client] of mqttClients) { client.end(); mqttClients.delete(url); }
  const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
  if (!devices.length) return;
  const upsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  const insert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  for (const device of devices) {
    if (!device.enabled || !device.broker) continue;
    const opts = {}; if (device.username) opts.username = device.username; if (device.password) opts.password = device.password;
    const client = mqtt.connect(device.broker, opts);
    mqttClients.set(device.broker, client);
    client.on('connect', () => {
      const topics = Object.values(device.topics || {}).filter(t => t);
      if (topics.length) client.subscribe(topics);
    });
    client.on('message', (topic, message) => {
      const val = parseFloat(message.toString());
      if (isNaN(val)) return;
      let metric;
      for (const [k, t] of Object.entries(device.topics || {})) { if (t === topic) { metric = k; break; } }
      if (!metric) return;
      const now = Math.floor(Date.now()/1000);
      upsert.run(metric, val, now);
      insert.run(now, metric, val);
      mqttValues[metric] = val;
    });
    client.on('error', (err) => console.error(`MQTT error:`, err));
  }
}

async function pollModbus() {
  const devices = JSON.parse(getConfig('modbus_devices') || '[]');
  if (!devices.length) return;
  const insert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const upsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  for (const device of devices) {
    if (!device.enabled || !device.host || !device.profile) continue;
    const profile = availableProfiles.find(p => p.id === device.profile);
    if (!profile) { console.error(`Profile ${device.profile} not found`); continue; }
    let client;
    try {
      client = new ModbusRTU();
      await client.connectTcp(device.host, { port: parseInt(device.port) || 502 });
      await client.setID(parseInt(device.unit) || 1);
      const results = {};
      const sorted = [...profile.registers].sort((a,b) => a.address - b.address);
      let i = 0;
      while (i < sorted.length) {
        const startAddr = sorted[i].address;
        let count = 0;
        while (i < sorted.length && sorted[i].address === startAddr + count && count < 32) { count++; i++; }
        try {
          const resp = await client.readHoldingRegisters(startAddr, count);
          for (let j = 0; j < resp.data.length; j++) {
            const reg = sorted[i - count + j];
            results[reg.metric] = (reg.scale ? resp.data[j] * reg.scale : resp.data[j]);
          }
        } catch(e) { console.error(`Modbus read error at ${startAddr}:`, e.message); }
      }
      client.close();
      const now = Math.floor(Date.now()/1000);
      for (const [metric, value] of Object.entries(results)) {
        insert.run(now, metric, value);
        upsert.run(metric, value, now);
        mqttValues[metric] = value;
      }
    } catch(e) { console.error(`Modbus poll error:`, e.message); if (client) client.close(); }
  }
}

async function pollLegacyHistory() {
  const metricMap = {
    consumption:'consumption', solar:'solar', battery_charge:'battery_charge', battery_discharge:'battery_discharge',
    grid_import:'grid_import', grid_export:'grid_export', battery_soc:'battery_soc',
    daily_consumption:'daily_consumption', daily_solar:'daily_solar', daily_battery_charge:'daily_battery_charge',
    daily_battery_discharge:'daily_battery_discharge', daily_grid_import:'daily_grid_import', daily_grid_export:'daily_grid_export'
  };
  const latest = db.prepare('SELECT metric, value FROM latest_metrics').all();
  const values = {};
  latest.forEach(r => { if (metricMap[r.metric]) values[metricMap[r.metric]] = r.value; });
  Object.values(metricMap).forEach(col => { if (!(col in values)) values[col] = 0; });
  const now = Math.floor(Date.now()/1000);
  db.prepare(`INSERT OR REPLACE INTO history (timestamp, consumption, solar, battery_charge, battery_discharge, grid_import, grid_export, battery_soc, daily_consumption, daily_solar, daily_battery_charge, daily_battery_discharge, daily_grid_import, daily_grid_export) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(now, values.consumption, values.solar, values.battery_charge, values.battery_discharge, values.grid_import, values.grid_export, values.battery_soc, values.daily_consumption, values.daily_solar, values.daily_battery_charge, values.daily_battery_discharge, values.daily_grid_import, values.daily_grid_export);
}

async function pollGridStatus() {
  const entity = getConfig('grid_status_entity');
  if (!entity) return;
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  const ha = haDevices.find(d => d.enabled);
  if (!ha || !ha.url || !ha.token) return;
  try {
    const res = await fetch(`${ha.url}/api/states/${entity}`, { headers: { Authorization: `Bearer ${ha.token}` }, timeout: 5000 });
    if (!res.ok) return;
    const data = await res.json();
    const state = parseGridState(data.state);
    const now = Math.floor(Date.now()/1000);
    const last = db.prepare('SELECT state FROM grid_status ORDER BY timestamp DESC LIMIT 1').get();
    if (!last || last.state !== state) db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(now, state);
  } catch(e) {}
}

async function pollAllSources() {
  try { await pollHomeAssistant(); await pollModbus(); await pollLegacyHistory(); await pollGridStatus(); }
  catch(e) { console.error('Polling error:', e); }
}
pollAllSources();
setInterval(pollAllSources, 30000);

// ── Solar computation ────────────────────────
function computeSolarForDate(dateStr) {
  const startUnix = Math.floor(new Date(dateStr + 'T00:00:00').getTime()/1000);
  const endUnix = Math.floor(new Date(dateStr + 'T23:59:59').getTime()/1000);
  const rows = db.prepare('SELECT timestamp, solar FROM history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);
  if (rows.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < rows.length-1; i++) {
    const dt = (rows[i+1].timestamp - rows[i].timestamp) / 3600;
    total += ((rows[i].solar + rows[i+1].solar) / 2000) * dt;
  }
  const last = rows[rows.length-1];
  const dtLast = (endUnix - last.timestamp) / 3600;
  if (dtLast > 0 && last.timestamp < endUnix) total += (last.solar/1000) * dtLast;
  return total;
}
function computeTodaySolar() {
  const now = new Date();
  const startUnix = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0).getTime()/1000);
  const endUnix = Math.floor(now.getTime()/1000);
  const rows = db.prepare('SELECT timestamp, solar FROM history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);
  if (rows.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < rows.length-1; i++) {
    const dt = (rows[i+1].timestamp - rows[i].timestamp) / 3600;
    total += ((rows[i].solar + rows[i+1].solar) / 2000) * dt;
  }
  const last = rows[rows.length-1];
  const dtLast = (endUnix - last.timestamp) / 3600;
  if (dtLast > 0) total += (last.solar/1000) * dtLast;
  return total;
}

const weatherCodeMap = { 0:{icon:'fi fi-sr-sun',desc:'Clear Sky'},1:{icon:'fi fi-sr-sun',desc:'Mainly Clear'},2:{icon:'fi fi-sr-cloud-sun',desc:'Partly Cloudy'},3:{icon:'fi fi-sr-cloud',desc:'Overcast'},45:{icon:'fi fi-sr-cloud',desc:'Fog'},48:{icon:'fi fi-sr-cloud',desc:'Depositing Rime Fog'},51:{icon:'fi fi-sr-cloud-rain',desc:'Light Drizzle'},53:{icon:'fi fi-sr-cloud-rain',desc:'Moderate Drizzle'},55:{icon:'fi fi-sr-cloud-rain',desc:'Dense Drizzle'},61:{icon:'fi fi-sr-cloud-rain',desc:'Slight Rain'},63:{icon:'fi fi-sr-cloud-rain',desc:'Moderate Rain'},65:{icon:'fi fi-sr-cloud-rain',desc:'Heavy Rain'},80:{icon:'fi fi-sr-cloud-rain',desc:'Rain Showers'} };
const DEFAULT_WEATHER = { icon:'fi fi-sr-sun', desc:'Clear Sky' };

// ── Public API ───────────────────────────────
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title','dashboard_logo','savings_currency','savings_rate','solar_capacity_kwp'];
    const config = {};
    keys.forEach(k => config[k] = getConfig(k));
    config.dashboard_title = config.dashboard_title || '⚡ Energy Dashboard';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
    res.json(config);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/current', async (req, res) => {
  try {
    const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
    const rateRow = db.prepare("SELECT value FROM config WHERE key = 'savings_rate'").get();
    const rate = parseFloat(rateRow?.value) || 0.30;
    const allTimeSolar = db.prepare("SELECT SUM(daily_solar) as total FROM (SELECT MAX(daily_solar) as daily_solar FROM history GROUP BY date(timestamp, 'unixepoch'))").get();
    const allTimeSavings = (allTimeSolar?.total || 0) * rate;
    if (latest) {
      const curr = getConfig('savings_currency') || '€';
      const dailySolarKwh = computeTodaySolar();
      res.json({
        consumption_kw: latest.consumption / 1000,
        solar_kw: latest.solar / 1000,
        battery_charge_kw: latest.battery_charge / 1000,
        battery_discharge_kw: latest.battery_discharge / 1000,
        grid_import_kw: latest.grid_import / 1000,
        grid_export_kw: latest.grid_export / 1000,
        battery_soc: latest.battery_soc,
        daily_consumption_kwh: latest.daily_consumption,
        daily_solar_kwh: dailySolarKwh,
        daily_battery_charge_kwh: latest.daily_battery_charge,
        daily_battery_discharge_kwh: latest.daily_battery_discharge,
        daily_grid_import_kwh: latest.daily_grid_import,
        daily_grid_export_kwh: latest.daily_grid_export,
        savings_currency: curr,
        savings_rate: rate,
        today_savings: dailySolarKwh * rate,
        all_time_savings: allTimeSavings,
        timestamp: latest.timestamp * 1000
      });
    } else res.json({ error: 'No data yet' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 1, 7);
  const since = Math.floor(Date.now()/1000) - days*24*3600;
  try {
    const rows = db.prepare('SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC').all(since);
    res.json(rows.map(r => ({ ...r, consumption_kw: r.consumption/1000, solar_kw: r.solar/1000, battery_charge_kw: r.battery_charge/1000, battery_discharge_kw: r.battery_discharge/1000, grid_import_kw: r.grid_import/1000, grid_export_kw: r.grid_export/1000, timestamp: r.timestamp*1000 })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/daily', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const since = Math.floor(Date.now()/1000) - days*24*3600;
  try {
    const rows = db.prepare("SELECT date(timestamp, 'unixepoch') as day, MAX(daily_consumption) as consumption_kwh, MAX(daily_solar) as solar_kwh, MAX(daily_battery_charge) as battery_charge_kwh, MAX(daily_battery_discharge) as battery_discharge_kwh, MAX(daily_grid_import) as grid_import_kwh, MAX(daily_grid_export) as grid_export_kwh FROM history WHERE timestamp >= ? GROUP BY day ORDER BY day ASC").all(since);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/monthly', async (req, res) => { /* unchanged */ });
app.get('/api/grid/status', async (req, res) => { /* unchanged */ });
app.get('/api/grid/hours', async (req, res) => { /* unchanged */ });
app.get('/api/grid/timeline', async (req, res) => { /* unchanged */ });
app.get('/api/savings', async (req, res) => { /* unchanged */ });
app.get('/api/solar-forecast', async (req, res) => { /* unchanged */ });

// ── Aggregated endpoint ──────────────────────
app.get('/api/dashboard-state', async (req, res) => {
  try {
    const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
    const dailySolarKwh = computeTodaySolar();
    const rateRow = db.prepare("SELECT value FROM config WHERE key = 'savings_rate'").get();
    const rate = parseFloat(rateRow?.value) || 0.30;
    const currency = getConfig('savings_currency') || '€';

    let currentData = { error: 'No data yet' };
    if (latest) {
      currentData = {
        consumption_kw: latest.consumption / 1000,
        solar_kw: latest.solar / 1000,
        battery_charge_kw: latest.battery_charge / 1000,
        battery_discharge_kw: latest.battery_discharge / 1000,
        grid_import_kw: latest.grid_import / 1000,
        grid_export_kw: latest.grid_export / 1000,
        battery_soc: latest.battery_soc,
        daily_consumption_kwh: latest.daily_consumption,
        daily_solar_kwh: dailySolarKwh,
        daily_battery_charge_kwh: latest.daily_battery_charge,
        daily_battery_discharge_kwh: latest.daily_battery_discharge,
        daily_grid_import_kwh: latest.daily_grid_import,
        daily_grid_export_kwh: latest.daily_grid_export,
        savings_currency: currency,
        savings_rate: rate,
        today_savings: dailySolarKwh * rate,
        timestamp: latest.timestamp * 1000
      };
    }

    const metricRows = db.prepare('SELECT metric, value, timestamp FROM latest_metrics').all();
    const latestMetrics = {};
    metricRows.forEach(r => { latestMetrics[r.metric] = { value: r.value, timestamp: r.timestamp * 1000 }; });

    const todaySolar = computeTodaySolar();
    const weekSolar = (() => {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const diff = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
      const weekStart = new Date(now); weekStart.setDate(now.getDate() - diff); weekStart.setHours(0,0,0,0);
      let total = 0;
      const loopDate = new Date(weekStart);
      const todayStr = now.toLocaleDateString('en-CA');
      while (loopDate.toLocaleDateString('en-CA') <= todayStr) {
        const dateStr = loopDate.toLocaleDateString('en-CA');
        total += (dateStr === todayStr) ? computeTodaySolar() : computeSolarForDate(dateStr);
        loopDate.setDate(loopDate.getDate() + 1);
      }
      return total;
    })();
    const monthSolar = (() => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      let total = 0;
      const loopDate = new Date(monthStart);
      const todayStr = now.toLocaleDateString('en-CA');
      while (loopDate.toLocaleDateString('en-CA') <= todayStr) {
        const dateStr = loopDate.toLocaleDateString('en-CA');
        total += (dateStr === todayStr) ? computeTodaySolar() : computeSolarForDate(dateStr);
        loopDate.setDate(loopDate.getDate() + 1);
      }
      return total;
    })();
    let allTimeSavings;
    const overrideValStr = getConfig('all_time_pv_savings_override');
    if (overrideValStr && !isNaN(parseFloat(overrideValStr))) {
      allTimeSavings = parseFloat(overrideValStr);
    } else {
      const allTimeRows = db.prepare(`SELECT timestamp, daily_solar FROM history WHERE daily_solar IS NOT NULL ORDER BY timestamp ASC`).all();
      const allDailyMax = {};
      allTimeRows.forEach(row => {
        const date = new Date(row.timestamp * 1000).toLocaleDateString('en-CA');
        const val = row.daily_solar;
        if (!allDailyMax[date] || val > allDailyMax[date]) { allDailyMax[date] = val; }
      });
      allTimeSavings = Object.values(allDailyMax).reduce((sum, val) => sum + val, 0) * rate;
    }
    const savings = { currency, today: todaySolar * rate, week: weekSolar * rate, month: monthSolar * rate, all: allTimeSavings };

    let gridStatus = { configured: false };
    const gridEntity = getConfig('grid_status_entity');
    if (gridEntity) {
      const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
      const haDevice = haDevices.find(d => d.enabled);
      if (haDevice) {
        try {
          const rawState = await fetch(`${haDevice.url}/api/states/${gridEntity}`, { headers: { Authorization: `Bearer ${haDevice.token}` }, timeout: 5000 })
            .then(r => r.json()).then(d => d.state).catch(() => 0);
          const currentState = parseGridState(rawState);
          const lastOn = db.prepare("SELECT timestamp FROM grid_status WHERE state = 1 ORDER BY timestamp DESC LIMIT 1").get();
          const lastOff = db.prepare("SELECT timestamp FROM grid_status WHERE state = 0 ORDER BY timestamp DESC LIMIT 1").get();
          gridStatus = { configured: true, current: currentState === 1, lastOn: lastOn ? lastOn.timestamp * 1000 : null, lastOff: lastOff ? lastOff.timestamp * 1000 : null };
        } catch(e) {}
      }
    }

    const gridHours = { day: 0, week: 0, month: 0, year: 0 };
    if (gridStatus.configured) {
      const now = new Date();
      const startUnix = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0).getTime()/1000);
      const endUnix = Math.floor(now.getTime()/1000);
      const periods = [
        { key: 'day', start: startUnix, end: endUnix },
        { key: 'week', start: Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay()===0?6:now.getDay()-1)), 0,0,0).getTime()/1000), end: endUnix },
        { key: 'month', start: Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime()/1000), end: endUnix },
        { key: 'year', start: Math.floor(new Date(now.getFullYear(), 0, 1).getTime()/1000), end: endUnix }
      ];
      for (const p of periods) {
        const initialState = getGridStateAt(p.start);
        const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(p.start, p.end);
        let hours = 0, lastState = initialState, lastTime = p.start;
        for (const row of rows) { if (lastState === 1) hours += (row.timestamp - lastTime) / 3600; lastState = row.state; lastTime = row.timestamp; }
        if (lastState === 1) hours += (p.end - lastTime) / 3600;
        gridHours[p.key] = Math.round(hours * 10) / 10;
      }
    }

    let gridTimeline = { configured: false, segments: [], windowStart: 0, windowEnd: 0 };
    if (gridStatus.configured) {
      const nowMs = Date.now();
      const windowStart = nowMs - 24 * 60 * 60 * 1000;
      const startUnix = Math.floor(windowStart / 1000), endUnix = Math.floor(nowMs / 1000);
      const initialState = getGridStateAt(startUnix);
      const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);
      const segments = []; let lastState = initialState, lastTime = startUnix;
      for (const row of rows) {
        if (row.timestamp > lastTime) { segments.push({ start: lastTime, end: row.timestamp, state: lastState }); lastState = row.state; lastTime = row.timestamp; }
        else lastState = row.state;
      }
      if (lastTime < endUnix) segments.push({ start: lastTime, end: endUnix, state: lastState });
      gridTimeline = { configured: true, segments: segments.map(s => ({ start: s.start * 1000, end: s.end * 1000, state: s.state })), windowStart, windowEnd: nowMs };
    }

    const powerDays = parseInt(req.query.powerDays) || 1;
    const historySince = Math.floor(Date.now()/1000) - powerDays * 24 * 3600;
    const historyRows = db.prepare('SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC').all(historySince);
    const powerHistory = historyRows.map(r => ({ timestamp: r.timestamp * 1000, consumption_kw: r.consumption/1000, solar_kw: r.solar/1000, battery_charge_kw: r.battery_charge/1000, grid_import_kw: r.grid_import/1000 }));

    const energyDays = parseInt(req.query.energyDays) || 7;
    const barSince = Math.floor(Date.now()/1000) - energyDays * 24 * 3600;
    const barRows = db.prepare("SELECT date(timestamp, 'unixepoch') as day, MAX(daily_solar) as solar_kwh, MAX(daily_grid_import) as grid_import_kwh, MAX(daily_consumption) as consumption_kwh FROM history WHERE timestamp >= ? GROUP BY day ORDER BY day ASC").all(barSince);
    const dailyEnergyBar = barRows.map(r => ({ day: r.day, solar_kwh: r.solar_kwh, grid_import_kwh: r.grid_import_kwh, consumption_kwh: r.consumption_kwh }));

    res.json({ current: currentData, metrics: latestMetrics, savings, gridStatus, gridHours, gridTimeline, powerHistory, dailyEnergyBar });
  } catch(e) { console.error('Aggregated state error:', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/metrics/names', async (req, res) => {
  try { const rows = db.prepare('SELECT DISTINCT metric FROM latest_metrics ORDER BY metric').all(); res.json(rows.map(r => r.metric)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Authenticated routes ─────────────────────
app.get('/api/test-forecast', authMiddleware, async (req, res) => { /* unchanged */ });
app.get('/api/ha-device-entities', authMiddleware, async (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).json({ error: 'URL and token required' });
  try {
    const response = await fetch(`${url}/api/states`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 });
    if (!response.ok) throw new Error(`HA error ${response.status}`);
    const data = await response.json();
    const sensors = data.filter(e => e.entity_id.startsWith('sensor.') || e.entity_id.startsWith('binary_sensor.')).map(e => e.entity_id);
    res.json(sensors);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard-config', async (req, res) => {
  try {
    let configStr = getConfig('dashboard_config');
    if (configStr) return res.json(JSON.parse(configStr));
    const defaultConfig = {
      dashboards: [{
        id: 'main', name: 'Main',
        layout: [
          { type: 'flow-card' },
          { type: 'forecast-banner' },
          { type: 'metric-cards', cards: [
            { id:'daily_solar', title:"Today's Solar", metric:'daily_solar', unit:'kWh' },
            { id:'daily_consumption', title:"Today's Usage", metric:'daily_consumption', unit:'kWh' },
            { id:'daily_grid_import', title:"Today's Grid", metric:'daily_grid_import', unit:'kWh' },
            { id:'battery_voltage', title:'Battery Voltage', metric:'battery_voltage', unit:'V' },
            { id:'inverter_temp', title:'Inverter Temp', metric:'inverter_temp', unit:'°C' },
            { id:'solar_voltage', title:'Solar Voltage', metric:'solar_voltage', unit:'V' }
          ]},
          { type: 'savings-summary' },
          { type: 'grid-card' },
          { type: 'chart-power' },
          { type: 'chart-energy' },
          { type: 'data-table-daily' },
          { type: 'data-table-monthly' }
        ]
      }],
      activeDashboard: 'main'
    };
    setConfig('dashboard_config', JSON.stringify(defaultConfig));
    res.json(defaultConfig);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dashboard-config', authMiddleware, async (req, res) => {
  try { setConfig('dashboard_config', JSON.stringify(req.body)); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test-mqtt', authMiddleware, async (req, res) => { /* unchanged */ });
app.get('/api/test-mqtt-topic', authMiddleware, async (req, res) => { /* unchanged */ });

app.get('/api/backup', authMiddleware, (req, res) => {
  try { if (db) db.close(); res.download(DB_PATH, `backup-${Date.now()}.db`, (err) => { initializeDatabase(); if (err) console.error(err); }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', authMiddleware, upload.single('dbfile'), async (req, res) => { /* unchanged */ });

app.use('/api/settings', authMiddleware);
app.get('/api/settings', async (req, res) => {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(r => config[r.key] = r.value);
  res.json(config);
});
app.post('/api/settings', async (req, res) => { /* unchanged */ });

app.get('/api/modbus/profiles', authMiddleware, (req, res) => {
  res.json(availableProfiles.map(p => ({ id: p.id, name: p.name })));
});
app.get('/api/test-modbus', authMiddleware, async (req, res) => { /* unchanged */ });

app.get('/settings', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

app.get('/api/metrics/current', async (req, res) => {
  try {
    const rows = db.prepare('SELECT metric, value, timestamp FROM latest_metrics').all();
    const result = {};
    rows.forEach(r => result[r.metric] = { value: r.value, timestamp: r.timestamp * 1000 });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/metrics/history', async (req, res) => {
  const metric = req.query.metric;
  const hours = parseInt(req.query.hours) || 24;
  if (!metric) return res.status(400).json({ error: 'Metric name required' });
  const since = Math.floor(Date.now()/1000) - hours * 3600;
  try {
    const rows = db.prepare('SELECT timestamp, value FROM metrics WHERE metric = ? AND timestamp >= ? ORDER BY timestamp ASC').all(metric, since);
    res.json(rows.map(r => ({ timestamp: r.timestamp * 1000, value: r.value })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Energy dashboard running on port ${PORT}`));
