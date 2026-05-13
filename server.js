require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { initializeDatabase, getConfig, setConfig, getDb, DB_PATH } = require('./modules/database');
const { authMiddleware, authLimiter, csrfProtection } = require('./modules/auth');
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

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database, load profiles, start MQTT
initializeDatabase();
const db = getDb();   // global db reference for this file
loadProfiles();
setupMqtt();

// Multer for restore
const upload = multer({
  dest: '/tmp/',
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.db')) cb(null, true);
    else cb(new Error('Only .db files allowed'));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/api', csrfProtection);

// Polling loop
async function pollAllSources() {
  try {
    await pollHomeAssistant();
    await pollModbus();
    await pollLegacyHistory();
    await pollGridStatus();
  } catch (err) {
    console.error('Polling error:', err);
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily', async (req, res) => {
  const requestedDays = parseInt(req.query.days) || 30;
  const days = Math.min(requestedDays, 365);
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 24 * 3600);
  try {
    const rows = db.prepare(`
      SELECT date(timestamp, 'unixepoch') as day,
        MAX(daily_consumption) as consumption_kwh,
        MAX(daily_solar) as solar_kwh,
        MAX(daily_battery_charge) as battery_charge_kwh,
        MAX(daily_battery_discharge) as battery_discharge_kwh,
        MAX(daily_grid_import) as grid_import_kwh,
        MAX(daily_grid_export) as grid_export_kwh
      FROM history WHERE timestamp >= ?
      GROUP BY day ORDER BY day ASC
    `).all(since);
    res.json(rows);
  } catch (err) {
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/status', async (req, res) => {
  try {
    res.json(await getCurrentGridStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/hours', async (req, res) => {
  try {
    const hours = await getGridHours(req.query.period || 'day');
    res.json({ period: req.query.period || 'day', hours });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/grid/timeline', async (req, res) => {
  try {
    res.json(await getGridTimeline(req.query.period || '24h'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/savings', async (req, res) => {
  try {
    res.json(await getSavings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/solar-forecast', async (req, res) => {
  try {
    res.json(await getSolarForecast());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard-state', async (req, res) => {
  try {
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
    res.json({
      current: currentData,
      metrics,
      savings,
      gridStatus,
      gridHours,
      gridTimeline,
      powerHistory,
      dailyEnergyBar
    });
  } catch (err) {
    console.error('Aggregated state error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Protected API (auth + rate limiting + CSRF) ----------
app.use('/api/test-forecast', authMiddleware, authLimiter);
app.get('/api/test-forecast', async (req, res) => {
  try {
    res.json(await testForecast());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/ha-device-entities', authMiddleware, authLimiter);
app.get('/api/ha-device-entities', async (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).json({ error: 'HA URL and token required' });
  try {
    res.json(await fetchHAEntities(url, token));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/test-mqtt', authMiddleware, authLimiter);
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

app.use('/api/test-mqtt-topic', authMiddleware, authLimiter);
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

app.use('/api/modbus/profiles', authMiddleware, authLimiter);
app.get('/api/modbus/profiles', (req, res) => {
  res.json(availableProfiles.map(p => ({ id: p.id, name: p.name })));
});

app.use('/api/test-modbus', authMiddleware, authLimiter);
app.get('/api/test-modbus', async (req, res) => {
  const devices = JSON.parse(getConfig('modbus_devices') || '[]');
  const device = devices.find(d => d.enabled);
  if (!device || !device.host) return res.status(400).json({ error: 'No Modbus device configured' });
  try {
    const result = await testModbusConnection(device);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/dashboard-config', authMiddleware, authLimiter);
app.post('/api/dashboard-config', (req, res) => {
  try {
    saveDashboardConfig(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/backup', authMiddleware, authLimiter);
app.get('/api/backup', (req, res) => backupDatabase(res));

app.use('/api/restore', authMiddleware, authLimiter);
app.post('/api/restore', upload.single('dbfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    await restoreDatabase(req.file.path);
    res.json({ success: true, message: 'Database restored successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Restore failed, original database restored. ' + err.message });
  } finally {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e) {}
  }
});

app.use('/api/settings', authMiddleware, authLimiter);
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
    const forecastKeys = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id',
      'solar_loss_factor', 'solar_install_date'
    ];
    if (Object.keys(updates).some(k => forecastKeys.includes(k))) {
      // Force cache reset by re-importing solar module (optional)
      // The getSolarForecast will see empty cache on next call
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Settings] Save error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/settings', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/api/metrics/current', async (req, res) => {
  try {
    res.json(getCurrentMetrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metrics/history', async (req, res) => {
  const metric = req.query.metric;
  const hours = parseInt(req.query.hours) || 24;
  try {
    res.json(getMetricHistory(metric, hours));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard-config', async (req, res) => {
  res.json(getDashboardConfig());
});

app.listen(PORT, () => console.log(`Energy dashboard running on port ${PORT}`));
