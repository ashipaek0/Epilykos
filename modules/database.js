const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

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
      timestamp INTEGER
    );
  `);

  // Ensure essential keys exist
  const essentialKeys = [
    'ha_devices', 'mqtt_devices', 'modbus_devices', 'dashboard_config',
    'solar_latitude', 'solar_longitude', 'solar_tilt', 'solar_azimuth',
    'solar_capacity_kwp', 'solcast_api_key', 'forecast_enabled',
    'solar_loss_factor', 'solar_install_date', 'solcast_resource_id',
    'savings_currency', 'savings_rate', 'dashboard_title', 'dashboard_logo',
    'grid_status_entity', 'all_time_pv_savings_override', 'external_sources', 'external_poll_interval'
  ];

  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const key of essentialKeys) insertConfig.run(key, '');

  // Default values
  const defaults = {
    forecast_enabled: 'false',
    dashboard_title: '⚡ Energy Dashboard',
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
    console.log('Initialised default dashboard configuration');
  }

  console.log('Database initialized');
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
      console.log('Migrated legacy Home Assistant config to ha_devices array.');
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
      console.log('Migrated legacy MQTT config to mqtt_devices array.');
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
