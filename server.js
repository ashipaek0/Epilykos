/**
 * Epilykos Energy Dashboard — Express Server
 *
 * Core responsibilities:
 * - Serves static frontend files (HTML, CSS, JS modules)
 * - Provides REST API for dashboard state, metrics, config, and settings
 * - Manages WebSocket connections for real-time state push (30s interval)
 * - Orchestrates polling: HA, MQTT, Modbus, External REST, BMS bridge
 * - Session-based auth for settings/editor with CSRF protection
 * - Database backup/restore, layout import/export
 *
 * @module server
 */
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const httpFetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const morgan = require('morgan');
const WebSocket = require('ws');
const http = require('http');
const net = require('net');
const { logger } = require('./modules/logger');
const { initializeDatabase, getConfig, setConfig, getDb, DB_PATH } = require('./modules/database');
const { isAuthenticated, loginLimiter, csrfProtection, settingsPassword } = require('./modules/sessionAuth');
const { pollHomeAssistant, fetchHAEntities } = require('./modules/ha');
const { setupMqtt, restartMqtt, mqttClients } = require('./modules/mqtt');
const { loadProfiles, pollModbus, testModbusConnection, availableProfiles } = require('./modules/modbus');
const { loadRs232Profiles, pollRs232, testRs232Connection, getAvailablePorts, shutdownRs232, restartRs232Streaming, availableProfiles: rs232Profiles } = require('./modules/rs232');
const { pollLegacyHistory } = require('./modules/history');
const { pollGridStatus, getCurrentGridStatus, getGridHours, getGridTimeline } = require('./modules/grid');
const { computeTodaySolar, getSolarForecast, testForecast } = require('./modules/solar');
const { getSavings } = require('./modules/savings');
const { getCurrentMetrics, getMetricHistory } = require('./modules/metrics');
const { getDashboardConfig, saveDashboardConfig } = require('./modules/dashboard-config');
const { backupDatabase, restoreDatabase, startSnapshotScheduler, stopSnapshotScheduler, listSnapshots, restoreFromSnapshot } = require('./modules/backup');
const { parseGridState } = require('./modules/utils');
const { startExternalPolling, restartExternalPolling, stopExternalPolling } = require('./modules/external');
const { startBmsPolling, restartBmsPolling, stopBmsPolling } = require('./modules/bms');
const { startDonglePolling, restartDonglePolling, stopDonglePolling } = require('./modules/dongle');
const pvoutput = require('./modules/pvoutput');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Global rate limiter — 200 requests per 15 min per IP
const globalLimiter = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, max: 2000, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

// Morgan HTTP request logging (stream to winston)
app.use(morgan('combined', { stream: logger.stream }));

// Compression (gzip + brotli)
app.use(compression());

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize database, load profiles, start MQTT and external polling
initializeDatabase();
const db = getDb();
loadProfiles();
loadRs232Profiles();  // RS232 serial inverter profiles
setupMqtt();
startExternalPolling();
startBmsPolling();   // Start BMS bridge polling
startDonglePolling();
pvoutput.start();     // Start PVOutput push/pull engines
startSnapshotScheduler();

// Multer for restore and import
const upload = multer({
  dest: '/tmp/',
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.db') || file.originalname.endsWith('.json')) cb(null, true);
    else cb(new Error('Only .db or .json files allowed'));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Middleware
// Serve static files with 1h browser cache
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', immutable: true }));
app.use(express.json());
app.use('/api', csrfProtection);

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected WebSocket clients
const wsClients = new Set();

/**
 * Push dashboard state to all connected WebSocket clients.
 * Each client receives JSON: { type: 'dashboard-state', data: state }
 * @param {object} state - built by buildDashboardState()
 */
function broadcastDashboardState(state) {
  const message = JSON.stringify({ type: 'dashboard-state', data: state });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message, err => {
        if (err) {
          wsClients.delete(client);
          client.terminate();
        }
      });
    }
  }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  wsClients.add(ws);
  logger.info(`WebSocket client connected (${wsClients.size} total)`);
  
  (async () => {
    try {
      const state = await buildDashboardState();
      ws.send(JSON.stringify({ type: 'dashboard-state', data: state }));
    } catch (err) {
      logger.error('Error sending initial state via WebSocket:', err);
    }
  })();

  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info(`WebSocket client disconnected (${wsClients.size} remaining)`);
  });
  ws.on('error', () => {
    wsClients.delete(ws);
    ws.terminate();
  });
});

/**
 * Build the complete dashboard state object sent via WebSocket and REST API.
 * Aggregates: latest power values, all metrics, savings, grid status/hours/timeline,
 * 24h power history, 7d energy bar data.
 * @returns {Promise<object>} dashboard state
 */
async function buildDashboardState() {
  const start = Date.now();
  const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
  const dailySolarKwh = computeTodaySolar();
  const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
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
  const metrics = getCurrentMetrics();
  const savings = await getSavings();
  const gridStatus = await getCurrentGridStatus();
  const gridHours = {
    day: gridStatus.configured ? await getGridHours('day') : 0,
    week: gridStatus.configured ? await getGridHours('week') : 0,
    month: gridStatus.configured ? await getGridHours('month') : 0,
    year: gridStatus.configured ? await getGridHours('year') : 0
  };
  const gridTimeline = gridStatus.configured ? await getGridTimeline('24h') : { configured: false, segments: [], windowStart: 0, windowEnd: 0 };
  const historySince = Math.floor(Date.now() / 1000) - 24 * 3600;
  const historyRows = db.prepare('SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC').all(historySince);
  const powerHistory = historyRows.map(r => ({
    timestamp: r.timestamp * 1000,
    consumption_kw: r.consumption / 1000,
    solar_kw: r.solar / 1000,
    battery_charge_kw: r.battery_charge / 1000,
    battery_discharge_kw: r.battery_discharge / 1000,
    grid_import_kw: r.grid_import / 1000,
    grid_export_kw: r.grid_export / 1000
  }));
  const barSince = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const barRows = db.prepare(`
    SELECT date(timestamp, 'unixepoch') as day,
      MAX(daily_solar) as solar_kwh,
      MAX(daily_consumption) as consumption_kwh,
      MAX(daily_battery_charge) as battery_charge_kwh,
      MAX(daily_battery_discharge) as battery_discharge_kwh,
      MAX(daily_grid_import) as grid_import_kwh,
      MAX(daily_grid_export) as grid_export_kwh
    FROM history WHERE timestamp >= ?
    GROUP BY day ORDER BY day ASC
  `).all(barSince);
  const dailyEnergyBar = barRows.map(r => ({
    day: r.day,
    solar_kwh: r.solar_kwh,
    consumption_kwh: r.consumption_kwh,
    battery_charge_kwh: r.battery_charge_kwh,
    battery_discharge_kwh: r.battery_discharge_kwh,
    grid_import_kwh: r.grid_import_kwh,
    grid_export_kwh: r.grid_export_kwh
  }));
  const elapsed = Date.now() - start;
  logger.debug(`buildDashboardState took ${elapsed}ms`);
  return {
    current: currentData,
    metrics,
    savings,
    gridStatus,
    gridHours,
    gridTimeline,
    powerHistory,
    dailyEnergyBar
  };
}

/**
 * Main 30-second polling cycle. Fetches data from all configured sources,
 * builds dashboard state, and broadcasts to WebSocket clients.
 * Runs once immediately on startup, then every 30s via setInterval.
 */
async function pollAllSources() {
  const start = Date.now();
  logger.debug('Polling cycle started');
  try {
    await pollHomeAssistant();
    await pollModbus();
    await pollRs232();         // RS232 serial inverter polling
    await pollLegacyHistory();
    await pollGridStatus();
    // BMS polling is independent and runs on its own interval
    const state = await buildDashboardState();
    broadcastDashboardState(state);
    const elapsed = Date.now() - start;
    logger.info(`Polling cycle completed in ${elapsed}ms`);
  } catch (err) {
    logger.error('Polling error:', err);
  }
}
pollAllSources();
const pollInterval = setInterval(pollAllSources, 30000);

// ---------- Public API (no auth) ----------
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title', 'dashboard_logo', 'dashboard_favicon', 'dashboard_bg_color', 'dashboard_bg_color_light', 'dashboard_bg_color_dark', 'dashboard_bg_image', 'transparent_blocks', 'desktop_dashboard', 'mobile_dashboard', 'savings_currency', 'savings_rate', 'solar_capacity_kwp'];
    const config = {};
    for (const key of keys) config[key] = getConfig(key);
    config.dashboard_title = config.dashboard_title || '⚡ Epilykos';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
    res.set('Cache-Control', 'public, max-age=300');
    res.json(config);
  } catch (err) {
    logger.error('Error in /api/public-config:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/current', async (req, res) => {
  try {
    const latest = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1').get();
    const rateRow = db.prepare('SELECT value FROM config WHERE key = ?').get('savings_rate');
    const rate = parseFloat(rateRow?.value) || 0.30;
    const allTimeSolar = db.prepare(`SELECT SUM(daily_solar) as total FROM (SELECT MAX(daily_solar) as daily_solar FROM history GROUP BY date(timestamp, 'unixepoch'))`).get();
    const allTimeSavings = (allTimeSolar?.total || 0) * rate;
    res.set('Cache-Control', 'public, max-age=10');
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
    } else {
      res.json({ error: 'No data yet' });
    }
  } catch (err) {
    logger.error('Error in /api/current:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  const requestedDays = parseInt(req.query.days) || 1;
  const days = Math.min(requestedDays, 7);
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = db.prepare(`SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`).all(since);
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
    logger.error('Error in /api/history:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily', async (req, res) => {
  const requestedDays = parseInt(req.query.days) || 30;
  const days = Math.min(requestedDays, 365);
  const now = new Date();
  const dateArray = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateArray.push(d.toISOString().split('T')[0]);
  }
  const startUnix = Math.floor(new Date(dateArray[0] + 'T00:00:00').getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  try {
    // Use MAX(daily_*) — the running cumulative totals — for reliable daily energy
    const rows = db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(startUnix, endUnix);
    const dataMap = {};
    rows.forEach(r => { dataMap[r.day] = r; });
    const result = dateArray.map(date => {
      const d = dataMap[date];
      return {
        day: date,
        consumption_kwh: d?.consumption_kwh || 0,
        solar_kwh: d?.solar_kwh || 0,
        battery_charge_kwh: d?.battery_charge_kwh || 0,
        battery_discharge_kwh: d?.battery_discharge_kwh || 0,
        grid_import_kwh: d?.grid_import_kwh || 0,
        grid_export_kwh: d?.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/daily:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monthly', async (req, res) => {
  try {
    const now = new Date();
    const months = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        display: `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`
      });
    }
    const rows = db.prepare(`
      WITH daily_max AS (
        SELECT date(timestamp, 'unixepoch') as day,
          MAX(daily_consumption) as consumption,
          MAX(daily_solar) as solar,
          MAX(daily_battery_charge) as battery_charge,
          MAX(daily_battery_discharge) as battery_discharge,
          MAX(daily_grid_import) as grid_import,
          MAX(daily_grid_export) as grid_export
        FROM history GROUP BY day
      )
      SELECT strftime('%Y-%m', day) as month,
        SUM(consumption) as consumption_kwh,
        SUM(solar) as solar_kwh,
        SUM(battery_charge) as battery_charge_kwh,
        SUM(battery_discharge) as battery_discharge_kwh,
        SUM(grid_import) as grid_import_kwh,
        SUM(grid_export) as grid_export_kwh
      FROM daily_max GROUP BY month ORDER BY month DESC LIMIT 12
    `).all();
    const dataMap = {};
    rows.forEach(r => { dataMap[r.month] = r; });
    const result = months.map(m => {
      const data = dataMap[m.key] || {};
      return {
        month: m.display,
        consumption_kwh: data.consumption_kwh || 0,
        solar_kwh: data.solar_kwh || 0,
        battery_charge_kwh: data.battery_charge_kwh || 0,
        battery_discharge_kwh: data.battery_discharge_kwh || 0,
        grid_import_kwh: data.grid_import_kwh || 0,
        grid_export_kwh: data.grid_export_kwh || 0
      };
    });
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/monthly:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/status', async (req, res) => {
  try {
    res.json(await getCurrentGridStatus());
  } catch (err) {
    logger.error('Error in /api/grid/status:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/hours', async (req, res) => {
  try {
    const hours = await getGridHours(req.query.period || 'day');
    res.json({ period: req.query.period || 'day', hours });
  } catch (err) {
    logger.error('Error in /api/grid/hours:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/timeline', async (req, res) => {
  try {
    res.json(await getGridTimeline(req.query.period || '24h'));
  } catch (err) {
    logger.error('Error in /api/grid/timeline:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/savings', async (req, res) => {
  try {
    res.json(await getSavings());
  } catch (err) {
    logger.error('Error in /api/savings:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/solar-forecast', async (req, res) => {
  try {
    res.json(await getSolarForecast());
  } catch (err) {
    logger.error('Error in /api/solar-forecast:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/solar/intraday', async (req, res) => {
  try {
    const field = req.query.field || 'solar';
    const allowed = ['solar', 'consumption', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export'];
    if (!allowed.includes(field)) return res.status(400).json({ error: `Invalid field. Allowed: ${allowed.join(', ')}` });
    const now = new Date();
    const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const rows = db.prepare(`SELECT timestamp, ${field} as watts, daily_solar FROM history WHERE timestamp >= ? ORDER BY timestamp ASC`).all(todayStart);
    res.json(rows.map(r => ({ timestamp: r.timestamp, watts: r.watts, daily_solar: r.daily_solar })));
  } catch (err) {
    logger.error('Error in /api/solar/intraday:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard-state', async (req, res) => {
  try {
    const state = await buildDashboardState();
    res.json(state);
  } catch (err) {
    logger.error('Aggregated state error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard config endpoint (public) – with error handling
app.get('/api/dashboard-config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const config = getDashboardConfig();
    res.json(config);
  } catch (err) {
    logger.error('Error fetching dashboard config:', err);
    const fallback = {
      dashboards: [{ id: 'main', name: 'Main', layout: [] }],
      activeDashboard: 'main'
    };
    res.status(500).json(fallback);
  }
});

// ---------- Authentication endpoints ----------
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password && password === settingsPassword) {
    req.session.authenticated = true;
    logger.info('User logged in successfully');
    return res.json({ success: true });
  }
  logger.warn('Failed login attempt');
  res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy();
  logger.info('User logged out');
  res.redirect('/');
});

// Auth status endpoint (public, but indicates session state)
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ---------- Protected API (session + CSRF) – no rate limit ----------
app.use('/api/test-forecast', isAuthenticated);
app.get('/api/test-forecast', async (req, res) => {
  try {
    res.json(await testForecast());
  } catch (err) {
    logger.error('Error in test-forecast:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/ha-device-entities', isAuthenticated);
app.get('/api/ha-device-entities', async (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).json({ error: 'HA URL and token required' });
  try {
    res.json(await fetchHAEntities(url, token));
  } catch (err) {
    logger.error('Error fetching HA entities:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/test-mqtt', isAuthenticated);
app.get('/api/test-mqtt', async (req, res) => {
  // Support pre-save testing: accept broker/username/password from query params
  const broker = req.query.broker || (() => {
    const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
    const device = devices.find(d => d.enabled);
    return device?.broker;
  })();
  const username = req.query.username || null;
  const password = req.query.password || null;
  if (!broker) return res.status(400).json({ error: 'No MQTT broker configured. Enter a broker URL first.' });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const testClient = require('mqtt').connect(broker, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) { testClient.end(); res.status(500).json({ error: 'Connection timeout' }); }
  }, 5000);
  testClient.on('connect', () => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; res.json({ success: true, message: 'Connected to MQTT broker' }); }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
  });
});

app.use('/api/test-mqtt-topic', isAuthenticated);
app.get('/api/test-mqtt-topic', async (req, res) => {
  const topic = req.query.topic;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  // Support pre-save testing: accept broker/username/password from query params
  const broker = req.query.broker || (() => {
    const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
    const device = devices.find(d => d.enabled);
    return device?.broker;
  })();
  const username = req.query.username || null;
  const password = req.query.password || null;
  if (!broker) return res.status(400).json({ error: 'No MQTT broker configured' });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const testClient = require('mqtt').connect(broker, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) { testClient.end(); res.status(500).json({ error: 'No message received within 5 seconds' }); }
  }, 5000);
  testClient.on('connect', () => testClient.subscribe(topic));
  testClient.on('message', (recTopic, message) => {
    if (recTopic === topic) {
      clearTimeout(timeout);
      testClient.end();
      if (!responded) {
        responded = true;
        const val = parseFloat(message.toString());
        if (!isNaN(val)) res.json({ success: true, value: val });
        else res.json({ success: true, value: null, raw: message.toString() });
      }
    }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
  });
});

// ── MQTT topic discovery ────────────────────────────────────────
app.use('/api/mqtt-discover-topics', isAuthenticated);
app.get('/api/mqtt-discover-topics', async (req, res) => {
  const broker = req.query.broker;
  const username = req.query.username || null;
  const password = req.query.password || null;
  if (!broker) return res.status(400).json({ error: 'Broker URL required' });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const mqtt = require('mqtt');
  const client = mqtt.connect(broker, options);
  let responded = false;
  const topics = new Set();
  const timeout = setTimeout(() => {
    client.end();
    if (!responded) {
      responded = true;
      const sorted = [...topics].sort();
      res.json({ success: true, topics: sorted, count: sorted.length });
    }
  }, 15000);
  client.on('connect', () => {
    client.subscribe('#', (err) => {
      if (err) {
        clearTimeout(timeout);
        client.end();
        if (!responded) { responded = true; res.status(500).json({ error: 'Subscribe failed: ' + err.message }); }
      }
    });
  });
  client.on('message', (topic) => { topics.add(topic); });
  client.on('error', (err) => {
    clearTimeout(timeout);
    client.end();
    if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
  });
});

app.use('/api/modbus/profiles', isAuthenticated);
app.get('/api/modbus/profiles', (req, res) => {
  res.json(availableProfiles.map(p => ({ id: p.id, name: p.name })));
});

app.use('/api/test-modbus', isAuthenticated);
app.post('/api/test-modbus', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (device.transport === 'tcp' && !device.host) return res.status(400).json({ error: 'Host required for TCP' });
  if (device.transport === 'serial' && !device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  try {
    const result = await testModbusConnection(device);
    res.json(result);
  } catch (err) {
    logger.error('Modbus test error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── RS232 API Endpoints ────────────────────────────────────────────────
app.use('/api/rs232/profiles', isAuthenticated);
app.get('/api/rs232/profiles', (req, res) => {
  res.json(rs232Profiles.map(p => ({ id: p.id, name: p.name, protocol: p.protocol })));
});

app.use('/api/rs232/ports', isAuthenticated);
app.get('/api/rs232/ports', async (req, res) => {
  try {
    const ports = await getAvailablePorts();
    res.json(Array.isArray(ports) ? ports : []);
  } catch (err) {
    logger.error('RS232 port scan error:', err);
    res.json([]);
  }
});

app.use('/api/test-rs232', isAuthenticated);
app.post('/api/test-rs232', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (!device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  if (!device.profile) return res.status(400).json({ error: 'Profile required' });
  try {
    const result = await testRs232Connection(device);
    res.json(result);
  } catch (err) {
    logger.error('RS232 test error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dashboard-config', isAuthenticated, (req, res) => {
  try {
    saveDashboardConfig(req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error saving dashboard config:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard-config/export', isAuthenticated, (req, res) => {
  const config = getDashboardConfig();
  res.setHeader('Content-Disposition', 'attachment; filename="dashboard-layout.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(config);
});

app.post('/api/dashboard-config/import', isAuthenticated, upload.single('layout'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const imported = JSON.parse(content);
    if (!imported.dashboards || !Array.isArray(imported.dashboards)) {
      throw new Error('Invalid dashboard config format');
    }
    // Merge: add imported dashboards to existing ones, avoiding ID collisions
    if (req.query.merge !== 'false') {
      const existing = getDashboardConfig();
      const existingIds = new Set(existing.dashboards.map(d => d.id));
      for (const db of imported.dashboards) {
        if (existingIds.has(db.id)) {
          db.id = 'db_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          if (db.name) db.name += ' (imported)';
        }
        existing.dashboards.push(db);
        existingIds.add(db.id);
      }
      saveDashboardConfig(existing);
    } else {
      saveDashboardConfig(imported);
    }
    fs.unlinkSync(req.file.path);
    res.json({ success: true });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    logger.error('Error importing dashboard config:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/backup', isAuthenticated);
app.get('/api/backup', (req, res) => backupDatabase(res));

app.use('/api/restore', isAuthenticated);
app.post('/api/restore', upload.single('dbfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    await restoreDatabase(req.file.path);
    res.json({ success: true, message: 'Database restored successfully' });
  } catch (err) {
    logger.error('Restore error:', err);
    res.status(500).json({ error: 'Restore failed, original database restored. ' + err.message });
  } finally {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e) {}
  }
});

// ── Snapshot API ──────────────────────────────────────────────

app.use('/api/snapshots', isAuthenticated);
app.get('/api/snapshots', (req, res) => {
  try {
    res.json(listSnapshots());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/snapshots/restore/:name', async (req, res) => {
  try {
    const result = await restoreFromSnapshot(decodeURIComponent(req.params.name));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/settings', isAuthenticated);
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});

app.post('/api/settings', (req, res) => {
  const updates = req.body;
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, String(value));
    }
    if ('mqtt_devices' in updates) restartMqtt();
    if ('external_sources' in updates || 'external_poll_interval' in updates) restartExternalPolling();
    if ('bms_devices' in updates) restartBmsPolling();
    if ('dongle_config' in updates) restartDonglePolling();
    if ('pvoutput_config' in updates) pvoutput.restart();
    if ('rs232_devices' in updates) restartRs232Streaming();
    const forecastKeys = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
      'solar_loss_factor', 'solar_install_date'
    ];
    if (Object.keys(updates).some(k => forecastKeys.includes(k))) {
      // Force cache reset
    }
    logger.info('Settings saved successfully');
    res.json({ success: true });
  } catch (err) {
    logger.error('[Settings] Save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// BMS bridge proxy – browser can't reach bms-bridge directly
const BMS_BRIDGE_URL = process.env.BMS_BRIDGE_URL || 'http://bms-bridge:8020';

app.use('/api/bms', isAuthenticated);

app.get('/api/bms/scan', async (req, res) => {
  try {
    const r = await httpFetch(`${BMS_BRIDGE_URL}/devices`, { timeout: 15000 });
    if (!r.ok) {
      const text = await r.text();
      logger.error(`BMS scan bridge returned ${r.status}: ${text.slice(0,200)}`);
      return res.status(502).json({ error: `Bridge returned ${r.status}` });
    }
    const data = await r.json();
    res.json(data);
  } catch (err) {
    logger.error('BMS scan proxy error:', err.message);
    res.status(502).json({ error: 'BMS bridge not reachable. Check that bms-bridge container is running.' });
  }
});

app.get('/api/bms/test', async (req, res) => {
  const address = req.query.address;
  if (!address) return res.status(400).json({ error: 'MAC address required' });
  try {
    const r = await httpFetch(`${BMS_BRIDGE_URL}/device/${encodeURIComponent(address)}`, { timeout: 10000 });
    if (!r.ok) {
      const text = await r.text();
      logger.error(`BMS test bridge returned ${r.status}: ${text.slice(0,200)}`);
      return res.status(502).json({ error: `Bridge returned ${r.status}` });
    }
    const data = await r.json();
    res.json(data);
  } catch (err) {
    logger.error('BMS test proxy error:', err.message);
    res.status(502).json({ error: 'BMS bridge not reachable. Check that bms-bridge container is running.' });
  }
});

app.use('/api/test-external', isAuthenticated);
app.post('/api/test-external', async (req, res) => {
  const { url, jsonPath } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const response = await fetch(url, { timeout: 5000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    let value = null;
    if (jsonPath) {
      const parts = jsonPath.split('.');
      let cur = data;
      for (const part of parts) cur = cur?.[part];
      value = cur;
    } else {
      value = data;
    }
    const num = parseFloat(value);
    res.json({ success: true, value: isNaN(num) ? value : num });
  } catch (err) {
    logger.error('Error testing external source:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== DONGLE ENDPOINTS (protected) ==========
app.get('/api/dongle/profiles', isAuthenticated, (req, res) => {
  try {
    const profilesDir = path.join(__dirname, 'profiles', 'dongles');
    if (!fs.existsSync(profilesDir)) return res.json([]);
    const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
    const profiles = files.map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf8'));
      return { id: f.replace('.json', ''), name: raw.name, transport: raw.transport, requires_serial: raw.requires_serial, default_port: raw.default_port, default_unit_id: raw.default_unit_id };
    });
    res.json(profiles);
  } catch (err) {
    logger.error('Error listing dongle profiles:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/dongle/test', isAuthenticated);
app.post('/api/dongle/test', async (req, res) => {
  const { host, port, serial_number, modbus_unit_id, transport } = req.body;
  if (!host) return res.status(400).json({ error: 'Host required' });

  const rawHost = String(host).trim();
  const isPrivateOrLocalIp = (ip) => {
    if (ip === '127.0.0.1' || ip === '::1') return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith('169.254.')) return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    if (ip.startsWith('fe80:')) return true;
    return false;
  };
  const isValidHostname = (value) => {
    if (value.length > 253) return false;
    const labels = value.split('.');
    return labels.every(label =>
      /^[a-zA-Z0-9-]{1,63}$/.test(label) &&
      !label.startsWith('-') &&
      !label.endsWith('-')
    );
  };

  const ipVersion = net.isIP(rawHost);
  if (ipVersion) {
    if (isPrivateOrLocalIp(rawHost.toLowerCase())) {
      return res.status(400).json({ error: 'Host is not allowed' });
    }
  } else {
    if (!isValidHostname(rawHost)) {
      return res.status(400).json({ error: 'Invalid host' });
    }
    const lowered = rawHost.toLowerCase();
    if (lowered === 'localhost' || lowered.endsWith('.local')) {
      return res.status(400).json({ error: 'Host is not allowed' });
    }
  }

  const parsedPort = Number.parseInt(port, 10);
  const safePort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null;
  if (port !== undefined && port !== null && port !== '' && safePort === null) {
    return res.status(400).json({ error: 'Invalid port' });
  }
  const safeHost = rawHost;

  try {
    let transportObj;
    if (transport === 'felicity-tcp') {
      transportObj = new (require('./modules/dongle/felicityTcp').FelicityTcpTransport)({ host: safeHost, port: safePort || 53970 });
      const data = await transportObj.poll();
      const count = data.realtime ? Object.keys(data.realtime).length : 0;
      res.json({ success: true, raw: `JSON OK — ${count} realtime keys` });
      return;
    }
    if (transport === 'solarman-v5') {
      transportObj = new (require('./modules/dongle/solarmanV5').SolarmanV5Transport)({ host: safeHost, port: safePort || 8899, serial_number, modbus_unit_id: modbus_unit_id || 1 });
    } else {
      transportObj = new (require('./modules/dongle/modbusTcp').ModbusTcpTransport)({ host: safeHost, port: safePort || 502, modbus_unit_id: modbus_unit_id || 1 });
    }
    const data = await transportObj.readRegisters(0x0100, 1);
    res.json({ success: true, raw: data.readUInt16BE(0) });
  } catch (err) {
    logger.warn(`[dongle] test connection failed to ${safeHost}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/dongle/status', isAuthenticated);
app.get('/api/dongle/status', (req, res) => {
  try {
    const raw = getConfig('dongle_config');
    if (!raw || raw === '[]') return res.json([]);
    const config = JSON.parse(raw);
    const result = config.map(inst => ({
      name: inst.name,
      enabled: inst.enabled,
      transport: inst.transport,
      lastSeen: inst.lastSeen || null,
      consecutiveFails: inst.consecutiveFails || 0
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PVOUTPUT ROUTES ==========
// Public webhook (CSRF skipped in sessionAuth.js — called by PVOutput servers)
app.use('/api/pvoutput/webhook', pvoutput.webhookRouter);
// Protected routes
app.use('/api/pvoutput', isAuthenticated, pvoutput.router);

// ========== METRIC MANAGEMENT ENDPOINTS (protected) ==========
app.get('/api/metrics/list', isAuthenticated, (req, res) => {
  try {
    const { getAllMetrics } = require('./modules/metricsManager');
    const metrics = getAllMetrics();
    res.json(metrics);
  } catch (err) {
    logger.error('Error fetching metrics list:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/metrics/create', isAuthenticated, (req, res) => {
  try {
    const { createMetric } = require('./modules/metricsManager');
    const { name, unit } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    createMetric(name, unit || '');
    res.json({ success: true });
  } catch (err) {
    logger.error('Error creating metric:', err);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/metrics/:name', isAuthenticated, (req, res) => {
  try {
    const { deleteMetric } = require('./modules/metricsManager');
    const { name } = req.params;
    deleteMetric(name);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error deleting metric:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Visual Editor (protected) ----------
app.get('/editor', (req, res) => {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// ---------- Settings page (protected) ----------
app.get('/settings', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// ---------- Login page (public) ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---------- Root route (public) ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Metrics endpoints ----------
app.get('/api/metrics/current', async (req, res) => {
  try {
    res.json(getCurrentMetrics());
  } catch (err) {
    logger.error('Error in /api/metrics/current:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metrics/history', async (req, res) => {
  const metric = req.query.metric;
  const hours = parseInt(req.query.hours) || 24;
  try {
    res.json(getMetricHistory(metric, hours));
  } catch (err) {
    logger.error('Error in /api/metrics/history:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metrics/names', async (req, res) => {
  try {
    const rows = db.prepare('SELECT metric FROM latest_metrics ORDER BY metric').all();
    const names = rows.map(r => r.metric);
    res.json(names);
  } catch (err) {
    logger.error('Error in /api/metrics/names:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Catch-all for SPA ----------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/settings') || req.path.startsWith('/login') || req.path.startsWith('/editor') || req.path.match(/\.(css|js|png|jpg|svg|ico)$/)) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start HTTP server with WebSocket support
server.listen(PORT, () => logger.info(`Energy dashboard running on port ${PORT} (session-based auth, log level: ${process.env.LOG_LEVEL || 'info'})`));

// ── Graceful Shutdown ──────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  await shutdownRs232();
  clearInterval(pollInterval);
  stopExternalPolling();
  stopBmsPolling();
  stopDonglePolling();
  stopSnapshotScheduler();
  for (const client of mqttClients.values()) client.end(true);
  mqttClients.clear();
  wss.close(() => wsClients.clear());
  db.close();
  logger.info('Shutdown complete');
});
process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down');
  await shutdownRs232();
  clearInterval(pollInterval);
  stopExternalPolling();
  stopBmsPolling();
  stopDonglePolling();
  stopSnapshotScheduler();
  for (const client of mqttClients.values()) client.end(true);
  mqttClients.clear();
  wss.close(() => wsClients.clear());
  db.close();
  logger.info('Shutdown complete');
});
