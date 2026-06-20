/**
 * SQLite Database Layer
 *
 * Single-file SQLite database at ./data/energy.db (WAL mode for concurrent reads).
 * Tables: history (power time-series), grid_status (ON/OFF state changes),
 * config (key-value settings), metrics (time-series), latest_metrics (current values).
 *
 * Key functions:
 * - getConfig(key) / setConfig(key, value) — key-value config store
 * - initializeDatabase() — creates tables, seeds defaults, migrates legacy configs
 *
 * @module database
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

let db;
const DB_PATH = './data/energy.db';

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function initializeDatabase() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      timestamp INTEGER PRIMARY KEY,
      consumption REAL,
      solar REAL,
      battery_charge REAL,
      battery_discharge REAL,
      grid_import REAL,
      grid_export REAL,
      battery_soc REAL,
      daily_consumption REAL,
      daily_solar REAL,
      daily_battery_charge REAL,
      daily_battery_discharge REAL,
      daily_grid_import REAL,
      daily_grid_export REAL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON history(timestamp);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS grid_status (
      timestamp INTEGER PRIMARY KEY,
      state INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      timestamp INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL,
      PRIMARY KEY (timestamp, metric)
    );
    CREATE TABLE IF NOT EXISTS latest_metrics (
      metric TEXT PRIMARY KEY,
      value REAL,
      timestamp INTEGER,
      unit TEXT
    );
  `);
  // Migration: add unit column to existing installs
  try { db.exec('ALTER TABLE latest_metrics ADD COLUMN unit TEXT'); } catch (e) { /* already exists */ }

  // PVOutput integration tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS pvoutput_upload_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT NOT NULL,
      time         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      reason       TEXT,
      status       TEXT DEFAULT 'pending',
      attempts     INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL,
      uploaded_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pvoutput_queue_date_status ON pvoutput_upload_queue(date, status);

    CREATE TABLE IF NOT EXISTS pvoutput_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT NOT NULL,
      time         TEXT NOT NULL,
      energy_gen   INTEGER,
      power_gen    INTEGER,
      energy_con   INTEGER,
      power_con    INTEGER,
      efficiency   REAL,
      temperature  REAL,
      voltage      REAL,
      UNIQUE(date, time)
    );
    CREATE INDEX IF NOT EXISTS idx_pvoutput_history_date ON pvoutput_history(date);

    CREATE TABLE IF NOT EXISTS pvoutput_daily_outputs (
      date         TEXT PRIMARY KEY,
      energy_gen   INTEGER,
      peak_power   INTEGER,
      peak_time    TEXT,
      energy_con   INTEGER,
      temperature_min REAL,
      temperature_max REAL,
      condition    TEXT,
      status       TEXT DEFAULT 'pending',
      attempts     INTEGER DEFAULT 0,
      source       TEXT NOT NULL DEFAULT 'push'
    );

    CREATE TABLE IF NOT EXISTS pvoutput_alerts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id        TEXT,
      alert_type       INTEGER,
      message          TEXT,
      pvoutput_datetime TEXT,
      received_at      TEXT NOT NULL,
      acknowledged     INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pvoutput_alerts_type ON pvoutput_alerts(alert_type, acknowledged);

    CREATE TABLE IF NOT EXISTS pvoutput_system (
      system_id    TEXT PRIMARY KEY,
      system_name  TEXT,
      system_size  INTEGER,
      postcode     TEXT,
      install_date TEXT,
      latitude     REAL,
      longitude    REAL,
      status_interval INTEGER,
      fetched_at   TEXT
    );
  `);

  // Ensure essential keys exist
  const essentialKeys = [
    'ha_devices', 'mqtt_devices', 'modbus_devices', 'dashboard_config',
    'solar_latitude', 'solar_longitude', 'solar_tilt', 'solar_azimuth',
    'solar_capacity_kwp', 'solcast_api_key', 'forecast_enabled',
    'solar_loss_factor', 'solar_install_date', 'solcast_resource_id',
    'savings_currency', 'savings_rate', 'savings_solar_metric', 'dashboard_title', 'dashboard_logo', 'dashboard_favicon', 'dashboard_bg_color', 'dashboard_bg_color_light', 'dashboard_bg_color_dark', 'dashboard_bg_image', 'transparent_blocks', 'desktop_dashboard', 'mobile_dashboard',
    'grid_status_entity', 'all_time_pv_savings_override', 'external_sources', 'external_poll_interval',
    'user_metrics', 'bms_devices', 'dongle_config', 'pvoutput_config', 'pvoutput_stats_cache', 'pvoutput_rate_limit_state',
    'rs232_devices'
  ];

  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const key of essentialKeys) insertConfig.run(key, '');

  // Default values
  const defaults = {
    forecast_enabled: 'false',
    dashboard_title: '⚡ Epilykos',
    savings_currency: '€',
    savings_rate: '0.30',
    solar_loss_factor: '0.9',
    solar_install_date: new Date().toISOString().split('T')[0],
    external_poll_interval: '60'
  };
  const updateConfig = db.prepare('UPDATE config SET value = ? WHERE key = ? AND value = ?');
  for (const [key, val] of Object.entries(defaults)) updateConfig.run(val, key, '');

  // Legacy migration
  migrateLegacyConfig();

  // Ensure dashboard_config exists with valid JSON
  const dashConfig = getConfig('dashboard_config');
  if (!dashConfig || dashConfig === '' || dashConfig === 'null') {
    const defaultConfig = {
      dashboards: [
        {
          id: 'main',
          name: 'Main',
          layout: [
            { type: 'flow-card' },
            { type: 'forecast-banner' },
            { type: 'metric-cards', cards: [
              { id: 'daily_solar', title: "Today's Solar", metric: 'daily_solar', unit: 'kWh' },
              { id: 'daily_consumption', title: "Today's Usage", metric: 'daily_consumption', unit: 'kWh' },
              { id: 'daily_grid_import', title: "Today's Grid", metric: 'daily_grid_import', unit: 'kWh' },
              { id: 'battery_voltage', title: 'Battery Voltage', metric: 'battery_voltage', unit: 'V' },
              { id: 'inverter_temp', title: 'Inverter Temp', metric: 'inverter_temp', unit: '°C' },
              { id: 'solar_voltage', title: 'Solar Voltage', metric: 'solar_voltage', unit: 'V' }
            ]},
            { type: 'savings-summary' },
            { type: 'grid-card' },
            { type: 'chart-power' },
            { type: 'chart-energy' },
            { type: 'data-table-daily' },
            { type: 'data-table-monthly' }
          ]
        }
      ],
      activeDashboard: 'main'
    };
    setConfig('dashboard_config', JSON.stringify(defaultConfig));
    logger.info('Initialised default dashboard configuration');
  }

  // Seed default metrics if none exist (user can delete/add freely)
  if (!getConfig('user_metrics') || getConfig('user_metrics') === '[]') {
    const defaultMetrics = [
      { name: 'Battery Power', unit: 'W' },
      { name: 'Battery Voltage', unit: 'V' },
      { name: 'Battery Current', unit: 'A' },
      { name: 'Battery Runtime', unit: 'h' },
      { name: 'Battery Charge Power', unit: 'W' },
      { name: 'Battery Discharge Power', unit: 'W' },
      { name: 'Battery Energy (Capacity)', unit: 'kWh' },
      { name: 'Battery Energy (Charge)', unit: 'kWh' },
      { name: 'Battery Energy (Discharge)', unit: 'kWh' },
      { name: 'Battery SOC', unit: '%' },
      { name: 'Battery Cell Voltage (Lowest)', unit: 'V' },
      { name: 'Battery Cell Voltage (Highest)', unit: 'V' },
      { name: 'Battery Cell Voltage (Average)', unit: 'V' },
      { name: 'Battery Temperature', unit: '°C' },
      { name: 'Grid Voltage', unit: 'V' },
      { name: 'Grid Power', unit: 'W' },
      { name: 'Grid Current', unit: 'A' },
      { name: 'Grid Energy Import', unit: 'kWh' },
      { name: 'Grid Energy Export', unit: 'kWh' },
      { name: 'Grid Status', unit: 'On/Off' },
      { name: 'PV Power', unit: 'W' },
      { name: 'PV Voltage', unit: 'V' },
      { name: 'PV Energy Generated', unit: 'kWh' },
      { name: 'PV Current', unit: 'A' },
      { name: 'PV Forecast Energy', unit: 'kWh' },
      { name: 'Load Power', unit: 'W' },
      { name: 'Load Current', unit: 'A' },
      { name: 'Load Energy Consumed', unit: 'kWh' },
      { name: 'Load %', unit: '%' },
      { name: 'Inverter Status', unit: '' },
      { name: 'Inverter Temperature', unit: '°C' },
      { name: 'Ambient Temperature', unit: '°C' },
      { name: 'Load Voltage', unit: 'V' },
      { name: 'Grid Frequency', unit: 'hz' },
      { name: 'Load Frequency', unit: 'hz' }
    ].map(m => ({ ...m, createdAt: Date.now() }));
    setConfig('user_metrics', JSON.stringify(defaultMetrics));
    logger.info(`Seeded ${defaultMetrics.length} default metrics`);
  }

  logger.info('Database initialized');
}

function migrateLegacyConfig() {
  const haDevicesStr = getConfig('ha_devices');
  const mqttDevicesStr = getConfig('mqtt_devices');

  if (!haDevicesStr || JSON.parse(haDevicesStr || '[]').length === 0) {
    const haUrl = getConfig('ha_url');
    const haToken = getConfig('ha_token');
    const haEnabled = getConfig('ha_enabled') === 'true';
    if (haUrl || haToken) {
      const entities = {};
      const entityMap = [
        'consumption', 'solar', 'battery_charge', 'battery_discharge',
        'grid_import', 'grid_export', 'battery_soc',
        'daily_consumption', 'daily_solar', 'daily_battery_charge',
        'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export',
        'battery_voltage', 'inverter_temp', 'solar_voltage', 'load_power'
      ];
      entityMap.forEach(metric => {
        const entity = getConfig(`ha_entity_${metric}`);
        if (entity) entities[metric] = entity;
      });
      const device = {
        name: 'Home Assistant',
        url: haUrl,
        token: haToken,
        enabled: haEnabled,
        poll_interval: 30,
        entities
      };
      setConfig('ha_devices', JSON.stringify([device]));
      db.prepare("DELETE FROM config WHERE key LIKE 'ha_entity_%' OR key IN ('ha_url','ha_token','ha_enabled')").run();
      logger.info('Migrated legacy Home Assistant config to ha_devices array.');
    }
  }

  if (!mqttDevicesStr || JSON.parse(mqttDevicesStr || '[]').length === 0) {
    const brokerUrl = getConfig('mqtt_broker_url');
    const username = getConfig('mqtt_username');
    const password = getConfig('mqtt_password');
    const mqttEnabled = getConfig('mqtt_enabled') === 'true';
    if (brokerUrl) {
      const topics = {};
      const topicMap = [
        'consumption', 'solar', 'battery_charge', 'battery_discharge',
        'grid_import', 'grid_export', 'battery_soc',
        'daily_consumption', 'daily_solar', 'daily_battery_charge',
        'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export',
        'battery_voltage', 'inverter_temp', 'solar_voltage', 'load_power'
      ];
      topicMap.forEach(metric => {
        const topic = getConfig(`mqtt_topic_${metric}`);
        if (topic) topics[metric] = topic;
      });
      const device = {
        name: 'MQTT Broker',
        broker: brokerUrl,
        username,
        password,
        enabled: mqttEnabled,
        topics
      };
      setConfig('mqtt_devices', JSON.stringify([device]));
      db.prepare("DELETE FROM config WHERE key LIKE 'mqtt_topic_%' OR key IN ('mqtt_broker_url','mqtt_username','mqtt_password','mqtt_enabled')").run();
      logger.info('Migrated legacy MQTT config to mqtt_devices array.');
    }
  }
}

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setConfig(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

Object.defineProperty(module.exports, 'db', {
  get: () => getDb()
});

module.exports = {
  initializeDatabase,
  getConfig,
  setConfig,
  getDb,
  DB_PATH
};
