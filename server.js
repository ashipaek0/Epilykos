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

// Session secret — persist across restarts so sessions survive
const SESSION_SECRET_FILE = path.join(__dirname, 'data', 'session-secret');
let sessionSecret = process.env.SESSION_SECRET;
if (sessionSecret) {
  logger.info('Using SESSION_SECRET from environment variable');
} else {
  logger.warn('⚠️  SESSION_SECRET env var not set — using persistent file-based secret');
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      sessionSecret = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (!sessionSecret) throw new Error('Empty secret file');
    } else {
      sessionSecret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
      fs.writeFileSync(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600 });
      logger.info('Generated new session secret and saved to data/session-secret');
    }
  } catch (err) {
    logger.error('Failed to read/write session secret file, falling back to ephemeral:', err.message);
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }
}

// Session middleware
app.use(session({
  secret: sessionSecret,
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
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message, err => {
        if (err) {
          wsClients.delete(client);
          client.terminate();
        }
      });
    }
  });
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
  // Parallelize independent DB/cache calls to avoid N+1 waterfall
  const historySince = Math.floor(Date.now() / 1000) - 24 * 3600;
  const barSince = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const [metrics, savings, gridStatus, historyRows, barRows] = await Promise.all([
    getCurrentMetrics(),
    getSavings(),
    getCurrentGridStatus(),
    db.prepare('SELECT * FROM history WHERE timestamp >= ? ORDER BY timestamp ASC').all(historySince),
    db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history WHERE timestamp >= ?
      GROUP BY day ORDER BY day ASC
    `).all(barSince)
  ]);
  // Parallelize all grid queries — 4 periods + timeline
  const [gridHoursDay, gridHoursWeek, gridHoursMonth, gridHoursYear, gridTimeline] = gridStatus.configured
    ? await Promise.all([
        getGridHours('day'), getGridHours('week'), getGridHours('month'), getGridHours('year'),
        getGridTimeline('24h')
      ])
    : [0, 0, 0, 0, { configured: false, segments: [], windowStart: 0, windowEnd: 0 }];
  const gridHours = {
    day: gridHoursDay,
    week: gridHoursWeek,
    month: gridHoursMonth,
    year: gridHoursYear
  };
  const powerHistory = historyRows.map(r => ({
    timestamp: r.timestamp * 1000,
    consumption_kw: r.consumption / 1000,
    solar_kw: r.solar / 1000,
    battery_charge_kw: r.battery_charge / 1000,
    battery_discharge_kw: r.battery_discharge / 1000,
    grid_import_kw: r.grid_import / 1000,
    grid_export_kw: r.grid_export / 1000
  }));
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
    if (wsClients.size > 0) {
      const state = await buildDashboardState();
      broadcastDashboardState(state);
    }
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/grid/status', async (req, res) => {
  try {
    res.json(await getCurrentGridStatus());
  } catch (err) {
    logger.error('Error in /api/grid/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/grid/hours', async (req, res) => {
  try {
    const hours = await getGridHours(req.query.period || 'day');
    res.json({ period: req.query.period || 'day', hours });
  } catch (err) {
    logger.error('Error in /api/grid/hours:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/grid/timeline', async (req, res) => {
  try {
    res.json(await getGridTimeline(req.query.period || '24h'));
  } catch (err) {
    logger.error('Error in /api/grid/timeline:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/savings', async (req, res) => {
  try {
    res.json(await getSavings());
  } catch (err) {
    logger.error('Error in /api/savings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/solar-forecast', async (req, res) => {
  try {
    res.json(await getSolarForecast());
  } catch (err) {
    logger.error('Error in /api/solar-forecast:', err);
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard-state', async (req, res) => {
  try {
    const state = await buildDashboardState();
    res.json(state);
  } catch (err) {
    logger.error('Aggregated state error:', err);
    res.status(500).json({ error: 'Internal server error' });
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
    res.json(await testForecast(req.query));
  } catch (err) {
    logger.error('Error in test-forecast:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/role-metrics', isAuthenticated);
app.get('/api/role-metrics', (req, res) => {
  const raw = getConfig('role_metrics');
  res.json(raw ? JSON.parse(raw) : {});
});
app.post('/api/role-metrics', (req, res) => {
  const mapping = req.body;
  if (typeof mapping !== 'object' || mapping === null) return res.status(400).json({ error: 'Expected JSON object' });
  setConfig('role_metrics', JSON.stringify(mapping));
  logger.info('[role-metrics] Updated mapping:', mapping);
  res.json({ success: true });
});

app.use('/api/ha-device-entities', isAuthenticated);
app.get('/api/ha-device-entities', async (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).json({ error: 'HA URL and token required' });
  try {
    res.json(await fetchHAEntities(url, token));
  } catch (err) {
    logger.error('Error fetching HA entities:', err);
    res.status(500).json({ error: 'Internal server error' });
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
    if (!responded) { responded = true; logger.error('MQTT test connection error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
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
    if (!responded) { responded = true; logger.error('MQTT topic test error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
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
        if (!responded) { responded = true; logger.error('MQTT subscribe error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
      }
    });
  });
  client.on('message', (topic) => { topics.add(topic); });
  client.on('error', (err) => {
    clearTimeout(timeout);
    client.end();
    if (!responded) { responded = true; logger.error('MQTT discover error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
  });
});

app.use('/api/modbus/profiles', isAuthenticated);
app.get('/api/modbus/profiles', (req, res) => {
  res.json(availableProfiles.map(p => ({ id: p.id, name: p.name })));
});

app.use('/api/modbus/profile', isAuthenticated);
app.get('/api/modbus/profile/:id', (req, res) => {
  const { getProfileById } = require('./modules/modbus');
  const profile = getProfileById(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RS232 API Endpoints ────────────────────────────────────────────────
app.use('/api/rs232/profiles', isAuthenticated);
app.get('/api/rs232/profiles', (req, res) => {
  res.json(rs232Profiles.map(p => ({ id: p.id, name: p.name, protocol: p.protocol })));
});

app.use('/api/rs232/profile', isAuthenticated);
app.get('/api/rs232/profile/:id', (req, res) => {
  const profile = rs232Profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Resolve profile_file alias and return full profile with fields/commands
  const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const profilePath = path.join(__dirname, 'profiles', 'rs232', `${safeId}.json`);
  try {
    const fullProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    res.json(fullProfile);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/dashboard-config', isAuthenticated, (req, res) => {
  try {
    saveDashboardConfig(req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error saving dashboard config:', err);
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Restore failed, original database restored.' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/snapshots/restore/:name', async (req, res) => {
  try {
    const result = await restoreFromSnapshot(decodeURIComponent(req.params.name));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
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
    // Reject keys matching sensitive patterns (token, password, secret, key, etc.)
    const sensitivePattern = /_token$|_password$|_secret$/i;
    const filteredUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      if (sensitivePattern.test(key)) {
        logger.warn(`[Settings] Rejected sensitive key: ${key}`);
        continue;
      }
      filteredUpdates[key] = value;
    }
    const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(filteredUpdates)) {
      stmt.run(key, String(value));
    }
    if ('mqtt_devices' in filteredUpdates) restartMqtt();
    if ('external_sources' in filteredUpdates || 'external_poll_interval' in filteredUpdates) restartExternalPolling();
    if ('bms_devices' in filteredUpdates) restartBmsPolling();
    if ('bms_banks' in filteredUpdates) {
      // Orphan cleanup: diff old vs new, delete unreferenced bank_* metrics
      const { cleanupOrphanedBankMetrics } = require('./modules/bmsAggregator');
      const oldBanks = JSON.parse(getConfig('bms_banks') || '[]');
      const newBanks = JSON.parse(filteredUpdates['bms_banks']);
      cleanupOrphanedBankMetrics(oldBanks, newBanks);
      // Auto-create bank metrics not yet in the system
      const { createMetric } = require('./modules/metricsManager');
      for (const bank of newBanks) {
        const safeName = bank.name.replace(/[^a-zA-Z0-9_]/g, '_');
        for (const fn of (bank.functions || [])) {
          try { createMetric(`bank_${fn.output}`, ''); } catch (_) { /* idempotent */ }
        }
        try { createMetric(`bank_${safeName}_devices_online`, ''); } catch (_) {}
        try { createMetric(`bank_${safeName}_last_update`, ''); } catch (_) {}
      }
      restartBmsPolling();
    }
    if ('dongle_config' in filteredUpdates) restartDonglePolling();
    if ('pvoutput_config' in filteredUpdates) pvoutput.restart();
    if ('rs232_devices' in filteredUpdates) restartRs232Streaming();
    const forecastKeys = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
      'solar_loss_factor', 'solar_install_date'
    ];
    if (Object.keys(filteredUpdates).some(k => forecastKeys.includes(k))) {
      // Force cache reset
    }
    logger.info('Settings saved successfully');
    res.json({ success: true });
  } catch (err) {
    logger.error('[Settings] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Per-section save API ─────────────────────────────────────────

const sensitivePattern = /_token$|_password$|_secret$/i;

/**
 * Helper: save a whitelist of config keys from req.body.
 * Applies the sensitive-key filter, writes to DB, returns saved key list.
 * @param {string[]} allowedKeys - keys to accept
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {{ saved: string[] }}
 */
function saveConfigKeys(allowedKeys, req, res) {
  const updates = req.body;
  const filtered = {};
  for (const key of allowedKeys) {
    if (key in updates) {
      if (sensitivePattern.test(key)) {
        logger.warn(`[Settings] Rejected sensitive key: ${key}`);
        continue;
      }
      filtered[key] = updates[key];
    }
  }
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  const saved = [];
  for (const [key, value] of Object.entries(filtered)) {
    stmt.run(key, String(value));
    saved.push(key);
  }
  return { saved };
}

// Data sources: ha_devices, mqtt_devices, modbus_devices, rs232_devices,
// external_sources, bms_devices, bms_banks, dongle_config, pvoutput_config
app.post('/api/settings/data-sources', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'ha_devices', 'mqtt_devices', 'modbus_devices', 'rs232_devices',
      'external_sources', 'external_poll_interval',
      'bms_devices', 'bms_banks', 'dongle_config', 'pvoutput_config'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);

    if ('mqtt_devices' in req.body) restartMqtt();
    if ('external_sources' in req.body || 'external_poll_interval' in req.body) restartExternalPolling();
    if ('bms_devices' in req.body) restartBmsPolling();
    if ('bms_banks' in req.body) {
      const { cleanupOrphanedBankMetrics } = require('./modules/bmsAggregator');
      const oldBanks = JSON.parse(getConfig('bms_banks') || '[]');
      const newBanks = JSON.parse(req.body['bms_banks']);
      cleanupOrphanedBankMetrics(oldBanks, newBanks);
      const { createMetric } = require('./modules/metricsManager');
      for (const bank of newBanks) {
        const safeName = bank.name.replace(/[^a-zA-Z0-9_]/g, '_');
        for (const fn of (bank.functions || [])) {
          try { createMetric(`bank_${fn.output}`, ''); } catch (_) { /* idempotent */ }
        }
        try { createMetric(`bank_${safeName}_devices_online`, ''); } catch (_) {}
        try { createMetric(`bank_${safeName}_last_update`, ''); } catch (_) {}
      }
      restartBmsPolling();
    }
    if ('dongle_config' in req.body) restartDonglePolling();
    if ('pvoutput_config' in req.body) pvoutput.restart();
    if ('rs232_devices' in req.body) restartRs232Streaming();

    logger.info(`[Settings/data-sources] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/data-sources] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Metrics: user_metrics only
app.post('/api/settings/metrics', isAuthenticated, (req, res) => {
  try {
    const allowed = ['user_metrics'];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/metrics] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/metrics] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard: layouts, active, and display keys
app.post('/api/settings/dashboard', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'dashboard_layouts', 'dashboard_active',
      'desktop_dashboard', 'mobile_dashboard', 'transparent_blocks',
      'dashboard_bg_color_light', 'dashboard_bg_color_dark',
      'dashboard_bg_image', 'grid_status_entity'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);

    // If saving dashboard_layouts, also update the legacy dashboard_config blob
    if ('dashboard_layouts' in req.body || 'dashboard_active' in req.body) {
      try {
        const layoutsStr = getConfig('dashboard_layouts');
        const active = getConfig('dashboard_active');
        const dashboards = JSON.parse(layoutsStr || '[]');
        const legacyBlob = JSON.parse(getConfig('dashboard_config') || '{}');
        legacyBlob.dashboards = dashboards;
        legacyBlob.activeDashboard = active;
        setConfig('dashboard_config', JSON.stringify(legacyBlob));
      } catch (_) { /* best-effort */ }
    }

    logger.info(`[Settings/dashboard] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/dashboard] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Solar: forecast keys + role_metrics
app.post('/api/settings/solar', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
      'solar_loss_factor', 'solar_install_date', 'role_metrics'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/solar] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/solar] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Savings: savings_* keys
app.post('/api/settings/savings', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'savings_currency', 'savings_rate', 'savings_solar_metric',
      'all_time_pv_savings_override'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/savings] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/savings] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Branding: dashboard appearance
app.post('/api/settings/branding', isAuthenticated, (req, res) => {
  try {
    const allowed = ['dashboard_title', 'dashboard_logo', 'dashboard_favicon'];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/branding] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/branding] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Network: network_* keys
app.post('/api/settings/network', isAuthenticated, (req, res) => {
  try {
    const allowed = ['network_local_url', 'network_remote_url'];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/network] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/network] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Backup: no-op (backup is action-based, not config)
app.post('/api/settings/backup', isAuthenticated, (req, res) => {
  res.json({ ok: true, saved: [] });
});

// BMS bridge proxy – browser can't reach bms-bridge directly
const BMS_BRIDGE_URL = process.env.BMS_BRIDGE_URL || 'http://bms-bridge:8020';

app.use('/api/bms', isAuthenticated);

app.get('/api/bms/scan', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const url = force ? `${BMS_BRIDGE_URL}/devices?force_scan=true` : `${BMS_BRIDGE_URL}/devices`;
    const r = await httpFetch(url, { timeout: 20000 });
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

// BMS bank aggregation — test endpoint
app.post('/api/bms/bank/test', async (req, res) => {
  const bank = req.body;
  if (!bank || !bank.devices || !bank.functions) {
    return res.status(400).json({ error: 'Bank config with devices and functions required' });
  }
  try {
    const { readLatestBmsMetrics, isDeviceFresh, resolveCapacity, computeFunction } = require('./modules/bmsAggregator');
    const pollInterval = parseInt(getConfig('bms_poll_interval')) || 30;
    const stalenessThreshold = pollInterval * 2;
    const now = Math.floor(Date.now() / 1000);

    // Gather raw data and freshness per device
    const deviceStatuses = {};
    const deviceData = {};
    let freshCount = 0;
    for (const device of (bank.devices || [])) {
      const raw = readLatestBmsMetrics(device.name);
      const fresh = isDeviceFresh(raw, stalenessThreshold);
      const newestTs = Object.keys(raw).length > 0
        ? Math.max(...Object.values(raw).map(m => m.timestamp))
        : null;
      deviceData[device.name] = { raw, fresh, device };
      deviceStatuses[device.name] = {
        status: fresh ? 'fresh' : 'stale',
        age_s: newestTs ? now - newestTs : null
      };
      if (fresh) freshCount++;
    }

    const willPublish = (freshCount / (bank.devices.length || 1)) >= 0.5;
    const results = {};
    const warnings = [];

    // Compute each function (preview only — don't write)
    for (const fn of (bank.functions || [])) {
      try {
        const values = [];
        const timestamps = [];
        for (const device of bank.devices) {
          const d = deviceData[device.name];
          if (!d.fresh) { values.push(undefined); timestamps.push(undefined); continue; }
          const src = d.raw[fn.source];
          values.push(src ? src.value : undefined);
          timestamps.push(src ? src.timestamp : undefined);
        }

        let weights = null;
        if (fn.fn === 'weighted_soc' || fn.fn === 'sum_weighted') {
          weights = [];
          let capCount = 0;
          for (const device of bank.devices) {
            const d = deviceData[device.name];
            if (!d.fresh) { weights.push(undefined); continue; }
            const cap = resolveCapacity(device, d.raw);
            if (cap == null) {
              warnings.push(`${device.name}: design_capacity not reported, excluded from ${fn.fn}`);
              weights.push(undefined);
            } else {
              weights.push(cap);
              capCount++;
            }
          }
          if (capCount < 2) {
            warnings.push(`${fn.fn}(${fn.source}): only ${capCount} devices have valid capacity — skipped`);
            continue;
          }
        }

        if (fn.fn === 'sum_weighted') {
          for (let i = 0; i < values.length; i++) {
            if (values[i] != null) values[i] = values[i] / 100;
          }
        }

        if (fn.fn === 'sum' && freshCount < bank.devices.length) {
          warnings.push(`sum(${fn.source}): partial set (${freshCount}/${bank.devices.length} devices) — value undercounted`);
        }

        const result = computeFunction(fn.fn, values, weights, timestamps);
        if (result != null) {
          results[`bank_${fn.output}`] = Math.round(result * 100) / 100;
        }
      } catch (err) {
        logger.error(`BMS bank compute error for ${fn.output}:`, err.message);
        warnings.push(`${fn.output}: computation failed`);
      }
    }

    res.json({
      results,
      devices: deviceStatuses,
      summary: {
        devices_total: bank.devices.length,
        devices_fresh: freshCount,
        will_publish: willPublish
      },
      warnings
    });
  } catch (err) {
    logger.error('BMS bank test error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// BMS device source keys — for function row dropdown in UI
app.get('/api/bms/device-metrics/:name', (req, res) => {
  const name = req.params.name;
  if (!name || name.length > 64) return res.status(400).json({ error: 'Invalid device name' });
  try {
    const { getAvailableSourceKeys } = require('./modules/bmsAggregator');
    const keys = getAvailableSourceKeys(name);
    res.json(keys);
  } catch (err) {
    logger.error('BMS device-metrics error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/dongle/profile', isAuthenticated);
app.get('/api/dongle/profile/:id', (req, res) => {
  try {
    const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const profilePath = path.join(__dirname, 'profiles', 'dongles', `${safeId}.json`);
    if (!fs.existsSync(profilePath)) return res.status(404).json({ error: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    res.json(profile);
  } catch (err) {
    logger.error('Error loading dongle profile:', err);
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Visual Editor (protected) ----------
app.get('/editor', (req, res) => {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// ---------- Network config (public, read-only) ----------
app.get('/api/network-config', (req, res) => {
  const localURL = getConfig('network_local_url') || '';
  const remoteURL = getConfig('network_remote_url') || '';
  res.json({ localURL, remoteURL });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics/history', async (req, res) => {
  const metric = req.query.metric;
  const hours = parseInt(req.query.hours) || 24;
  try {
    res.json(getMetricHistory(metric, hours));
  } catch (err) {
    logger.error('Error in /api/metrics/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics/names', async (req, res) => {
  try {
    const rows = db.prepare('SELECT metric FROM latest_metrics ORDER BY metric').all();
    const names = rows.map(r => r.metric);
    res.json(names);
  } catch (err) {
    logger.error('Error in /api/metrics/names:', err);
    res.status(500).json({ error: 'Internal server error' });
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
