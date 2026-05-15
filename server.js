require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const morgan = require('morgan');
const WebSocket = require('ws');
const http = require('http');
const { logger } = require('./modules/logger');
const { initializeDatabase, getConfig, setConfig, getDb, DB_PATH } = require('./modules/database');
const { isAuthenticated, loginLimiter, csrfProtection, settingsPassword } = require('./modules/sessionAuth');
const { pollHomeAssistant, fetchHAEntities } = require('./modules/ha');
const { setupMqtt, restartMqtt } = require('./modules/mqtt');
const { loadProfiles, pollModbus, testModbusConnection, availableProfiles } = require('./modules/modbus');
const { pollLegacyHistory } = require('./modules/history');
const { pollGridStatus, getCurrentGridStatus, getGridHours, getGridTimeline } = require('./modules/grid');
const { computeTodaySolar, getSolarForecast, testForecast } = require('./modules/solar');
const { getSavings } = require('./modules/savings');
const { getCurrentMetrics, getMetricHistory } = require('./modules/metrics');
const { getDashboardConfig, saveDashboardConfig } = require('./modules/dashboard-config');
const { backupDatabase, restoreDatabase } = require('./modules/backup');
const { parseGridState } = require('./modules/utils');
const { startExternalPolling, restartExternalPolling } = require('./modules/external');

const app = express();
const PORT = process.env.PORT || 3000;

// Morgan HTTP request logging (stream to winston)
app.use(morgan('combined', { stream: logger.stream }));

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
setupMqtt();
startExternalPolling();

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
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/api', csrfProtection);

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected WebSocket clients
const wsClients = new Set();

// Broadcast function
function broadcastDashboardState(state) {
  const message = JSON.stringify({ type: 'dashboard-state', data: state });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
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
});

// Helper to build dashboard state
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
    grid_import_kw: r.grid_import / 1000
  }));
  const barSince = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const barRows = db.prepare(`
    SELECT date(timestamp, 'unixepoch') as day,
      MAX(daily_solar) as solar_kwh,
      MAX(daily_grid_import) as grid_import_kwh,
      MAX(daily_consumption) as consumption_kwh
    FROM history WHERE timestamp >= ?
    GROUP BY day ORDER BY day ASC
  `).all(barSince);
  const dailyEnergyBar = barRows.map(r => ({
    day: r.day,
    solar_kwh: r.solar_kwh,
    grid_import_kwh: r.grid_import_kwh,
    consumption_kwh: r.consumption_kwh
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

// Polling loop
async function pollAllSources() {
  const start = Date.now();
  logger.debug('Polling cycle started');
  try {
    await pollHomeAssistant();
    await pollModbus();
    await pollLegacyHistory();
    await pollGridStatus();
    const state = await buildDashboardState();
    broadcastDashboardState(state);
    const elapsed = Date.now() - start;
    logger.info(`Polling cycle completed in ${elapsed}ms`);
  } catch (err) {
    logger.error('Polling error:', err);
  }
}
pollAllSources();
setInterval(pollAllSources, 30000);

// ---------- Public API (no auth) ----------
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/public-config', async (req, res) => {
  try {
    const keys = ['dashboard_title', 'dashboard_logo', 'savings_currency', 'savings_rate', 'solar_capacity_kwp'];
    const config = {};
    for (const key of keys) config[key] = getConfig(key);
    config.dashboard_title = config.dashboard_title || '⚡ Energy Dashboard';
    config.savings_currency = config.savings_currency || '€';
    config.savings_rate = config.savings_rate || '0.30';
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
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    // Fetch power readings (watts) from history
    const rows = db.prepare(`
      SELECT timestamp, consumption, solar, battery_charge, battery_discharge, grid_import, grid_export
      FROM history
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `).all(since);

    // Integrate watt‑seconds to kWh per day
    const dailyMap = new Map();
    for (let i = 0; i < rows.length - 1; i++) {
      const cur = rows[i];
      const next = rows[i + 1];
      const dtHours = (next.timestamp - cur.timestamp) / 3600;
      const day = new Date(cur.timestamp * 1000).toISOString().split('T')[0];
      if (!dailyMap.has(day)) {
        dailyMap.set(day, {
          day,
          consumption_kwh: 0,
          solar_kwh: 0,
          battery_charge_kwh: 0,
          battery_discharge_kwh: 0,
          grid_import_kwh: 0,
          grid_export_kwh: 0
        });
      }
      const entry = dailyMap.get(day);
      entry.consumption_kwh    += ((cur.consumption + next.consumption) / 2000) * dtHours;
      entry.solar_kwh          += ((cur.solar + next.solar) / 2000) * dtHours;
      entry.battery_charge_kwh += ((cur.battery_charge + next.battery_charge) / 2000) * dtHours;
      entry.battery_discharge_kwh += ((cur.battery_discharge + next.battery_discharge) / 2000) * dtHours;
      entry.grid_import_kwh    += ((cur.grid_import + next.grid_import) / 2000) * dtHours;
      entry.grid_export_kwh    += ((cur.grid_export + next.grid_export) / 2000) * dtHours;
    }

    const result = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day));
    res.json(result);
  } catch (err) {
    logger.error('Error in /api/daily:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monthly', async (req, res) => {
  try {
    // First compute the last 12 months of daily data (we'll reuse the daily endpoint logic)
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

    // Compute daily data for the last 365 days (or as far as needed)
    const since = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
    const rows = db.prepare(`
      SELECT timestamp, consumption, solar, battery_charge, battery_discharge, grid_import, grid_export
      FROM history
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `).all(since);

    const dailyMap = new Map();
    for (let i = 0; i < rows.length - 1; i++) {
      const cur = rows[i];
      const next = rows[i + 1];
      const dtHours = (next.timestamp - cur.timestamp) / 3600;
      const day = new Date(cur.timestamp * 1000).toISOString().split('T')[0];
      if (!dailyMap.has(day)) {
        dailyMap.set(day, {
          consumption: 0,
          solar: 0,
          battery_charge: 0,
          battery_discharge: 0,
          grid_import: 0,
          grid_export: 0
        });
      }
      const entry = dailyMap.get(day);
      entry.consumption    += ((cur.consumption + next.consumption) / 2000) * dtHours;
      entry.solar          += ((cur.solar + next.solar) / 2000) * dtHours;
      entry.battery_charge += ((cur.battery_charge + next.battery_charge) / 2000) * dtHours;
      entry.battery_discharge += ((cur.battery_discharge + next.battery_discharge) / 2000) * dtHours;
      entry.grid_import    += ((cur.grid_import + next.grid_import) / 2000) * dtHours;
      entry.grid_export    += ((cur.grid_export + next.grid_export) / 2000) * dtHours;
    }

    // Aggregate by month
    const monthlyMap = new Map();
    for (const [day, values] of dailyMap.entries()) {
      const monthKey = day.slice(0, 7); // YYYY-MM
      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, {
          consumption_kwh: 0,
          solar_kwh: 0,
          battery_charge_kwh: 0,
          battery_discharge_kwh: 0,
          grid_import_kwh: 0,
          grid_export_kwh: 0
        });
      }
      const monthData = monthlyMap.get(monthKey);
      monthData.consumption_kwh += values.consumption;
      monthData.solar_kwh += values.solar;
      monthData.battery_charge_kwh += values.battery_charge;
      monthData.battery_discharge_kwh += values.battery_discharge;
      monthData.grid_import_kwh += values.grid_import;
      monthData.grid_export_kwh += values.grid_export;
    }

    const result = months.map(m => {
      const data = monthlyMap.get(m.key) || {};
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
  const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
  const device = devices.find(d => d.enabled);
  if (!device || !device.broker) return res.status(400).json({ error: 'No MQTT broker configured' });
  const options = {};
  if (device.username) options.username = device.username;
  if (device.password) options.password = device.password;
  const testClient = require('mqtt').connect(device.broker, options);
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
  const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
  const device = devices.find(d => d.enabled);
  if (!device || !device.broker) return res.status(400).json({ error: 'No MQTT broker configured' });
  const options = {};
  if (device.username) options.username = device.username;
  if (device.password) options.password = device.password;
  const testClient = require('mqtt').connect(device.broker, options);
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

app.use('/api/dashboard-config', isAuthenticated);
app.post('/api/dashboard-config', (req, res) => {
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
    const config = JSON.parse(content);
    if (!config.dashboards || !Array.isArray(config.dashboards)) {
      throw new Error('Invalid dashboard config format');
    }
    saveDashboardConfig(config);
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

// Settings page (protected)
app.get('/settings', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Login page (public)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Root route – serve main dashboard (public)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

// Catch-all for SPA – must be after all explicit routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/settings') || req.path.startsWith('/login') || req.path.match(/\.(css|js|png|jpg|svg|ico)$/)) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the HTTP server with WebSocket support
server.listen(PORT, () => logger.info(`Energy dashboard running on port ${PORT} (session-based auth, log level: ${process.env.LOG_LEVEL || 'info'})`));
