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
const { localDateString } = require('./localTime');
const {
  SECRET_FIELDS,
  encryptString,
  decryptString,
  isEncrypted,
  encryptSecretFields,
} = require('./encryption');

let db;
const DB_PATH = './data/energy.db';

// Default dashboard layout seeded on first run (dashboard_layouts and the
// legacy dashboard_config blob both start from this).
// Starter dashboard: cards that read the metric roles (Settings > Metrics),
// so it carries no metric names of its own. '{{role:...}}' is filled in from
// the roles when the dashboard is read (dashboard-config.js).
const DEFAULT_DASHBOARD_LAYOUTS_JSON = `[{"id":"main","name":"Main","layout":[{"id":"b_overview","type":"system-overview","gridX":0,"gridY":0,"gridW":12,"gridH":7,"enabled":true,"config":{}},{"id":"b_totals","type":"energy-totals","gridX":0,"gridY":7,"gridW":12,"gridH":3,"enabled":true,"config":{}},{"id":"b_energy","type":"energy-tabs","gridX":0,"gridY":10,"gridW":12,"gridH":9,"enabled":true,"config":{"title":"Energy"}},{"id":"b_forecast","type":"forecast-pvtoday","gridX":0,"gridY":19,"gridW":6,"gridH":7,"enabled":true,"config":{"location_name":"","metrics":{"generated":"{{role:solar}}"}}},{"id":"b_grid","type":"grid-card","gridX":6,"gridY":19,"gridW":6,"gridH":7,"enabled":true,"config":{"showTimeline":true,"metrics":{"grid_status":""}}},{"id":"b_savings","type":"savings-summary","gridX":0,"gridY":26,"gridW":4,"gridH":4,"enabled":true,"config":{}},{"id":"b_power","type":"chart-power","gridX":4,"gridY":26,"gridW":8,"gridH":8,"enabled":true,"config":{"title":"Power"}},{"id":"b_daily","type":"data-table-daily","gridX":0,"gridY":34,"gridW":12,"gridH":8,"enabled":true,"config":{}}]}]`;

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function migratePowerStatsSchema(handle) {
  const columns = new Set(handle.prepare('PRAGMA table_info(history_5m)').all().map(column => column.name));
  const fields = ['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc'];
  for (const field of fields) {
    for (const suffix of ['last_value', 'last_timestamp']) {
      const name = `${field}_${suffix}`;
      if (!columns.has(name)) handle.exec(`ALTER TABLE history_5m ADD COLUMN ${name} ${suffix === 'last_timestamp' ? 'INTEGER' : 'REAL'}`);
    }
  }
  for (const [name, type] of Object.entries({
    battery_power_sum: 'REAL', battery_power_avg: 'REAL', battery_power_min: 'REAL',
    battery_power_max: 'REAL', battery_power_count: 'INTEGER',
    battery_power_last_value: 'REAL', battery_power_last_timestamp: 'INTEGER'
  })) {
    if (!columns.has(name)) handle.exec(`ALTER TABLE history_5m ADD COLUMN ${name} ${type}`);
  }
}

function initializeDatabase() {
  const dataDir = path.dirname(DB_PATH);
  let dbFile = DB_PATH;
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      // Still run the schema setup below so the in-memory DB is usable.
      logger.error(`Cannot create data directory ${dataDir}: ${err.message}. Falling back to in-memory database.`);
      dbFile = ':memory:';
    }
  }

  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  applySynchronousMode(db);

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
    CREATE INDEX IF NOT EXISTS idx_grid_status_state ON grid_status(state);
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
    CREATE INDEX IF NOT EXISTS idx_metrics_metric_ts ON metrics(metric, timestamp);
    CREATE TABLE IF NOT EXISTS latest_metrics (
      metric TEXT PRIMARY KEY,
      value REAL,
      timestamp INTEGER,
      unit TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_5m (
      bucket_start INTEGER NOT NULL,
      metric       TEXT    NOT NULL,
      value_avg    REAL,
      value_min    REAL,
      value_max    REAL,
      value_count  INTEGER NOT NULL CHECK (value_count >= 0),
      PRIMARY KEY (bucket_start, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_5m_metric_bucket ON metrics_5m(metric, bucket_start);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS history_5m (
      bucket_start INTEGER PRIMARY KEY,
      consumption_avg REAL, consumption_min REAL, consumption_max REAL, consumption_count INTEGER NOT NULL CHECK (consumption_count >= 0),
      solar_avg REAL, solar_min REAL, solar_max REAL, solar_count INTEGER NOT NULL CHECK (solar_count >= 0),
      battery_charge_avg REAL, battery_charge_min REAL, battery_charge_max REAL, battery_charge_count INTEGER NOT NULL CHECK (battery_charge_count >= 0),
      battery_discharge_avg REAL, battery_discharge_min REAL, battery_discharge_max REAL, battery_discharge_count INTEGER NOT NULL CHECK (battery_discharge_count >= 0),
      grid_import_avg REAL, grid_import_min REAL, grid_import_max REAL, grid_import_count INTEGER NOT NULL CHECK (grid_import_count >= 0),
      grid_export_avg REAL, grid_export_min REAL, grid_export_max REAL, grid_export_count INTEGER NOT NULL CHECK (grid_export_count >= 0),
      battery_soc_avg REAL, battery_soc_min REAL, battery_soc_max REAL, battery_soc_count INTEGER NOT NULL CHECK (battery_soc_count >= 0),
      daily_consumption_last REAL,
      daily_solar_last REAL,
      daily_battery_charge_last REAL,
      daily_battery_discharge_last REAL,
      daily_grid_import_last REAL,
      daily_grid_export_last REAL
    );
  `);

  const hasColumn = (tableName, columnName) => {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return columns.some(c => c.name === columnName);
  };

  const addColumnIfNotExists = (tableName, columnName, definition) => {
    if (!hasColumn(tableName, columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  };

  // Safe schema migrations with explicit PRAGMA column checking
  migratePowerStatsSchema(db);
  addColumnIfNotExists('latest_metrics', 'unit', 'TEXT');
  addColumnIfNotExists('latest_metrics', 'value_text', 'TEXT');
  addColumnIfNotExists('latest_metrics', 'value_type', "TEXT DEFAULT 'number'");
  addColumnIfNotExists('metrics', 'value_text', 'TEXT');
  addColumnIfNotExists('metrics', 'value_type', "TEXT DEFAULT 'number'");

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
    'forecast_default_source', 'weather_default_source',
    'savings_currency', 'savings_rate', 'savings_solar_metric', 'dashboard_title', 'dashboard_logo', 'dashboard_favicon', 'dashboard_bg_color', 'dashboard_bg_color_light', 'dashboard_bg_color_dark', 'dashboard_bg_image', 'transparent_blocks', 'desktop_dashboard', 'mobile_dashboard',
    'grid_status_entity', 'all_time_pv_savings_override', 'external_sources', 'external_poll_interval',
    'user_metrics', 'bms_devices', 'dongle_config', 'pvoutput_config', 'pvoutput_stats_cache', 'pvoutput_rate_limit_state',
    'rs232_devices',
    'tuya_devices',
    'tuya_cloud',
    // Dashboard blob split: new granular keys
    'dashboard_layouts', 'dashboard_active',
    // Network
    'network_local_url', 'network_remote_url',
    // Setup wizard
    'setup_wizard_completed'
  ];

  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  const updateConfig = db.prepare('UPDATE config SET value = ? WHERE key = ? AND value = ?');

  const seedTransaction = db.transaction(() => {
    for (const key of essentialKeys) insertConfig.run(key, '');
    // Default values
    const defaults = {
      forecast_enabled: 'false',
      forecast_default_source: 'auto',
      weather_default_source: 'auto',
      dashboard_title: '⚡ Epilykos',
      savings_currency: '€',
      savings_rate: '0.30',
      solar_loss_factor: '0.9',
      solar_install_date: localDateString(),
      external_poll_interval: '60'
    };
    for (const [key, val] of Object.entries(defaults)) updateConfig.run(val, key, '');
  });
  seedTransaction();

  // Legacy migration
  migrateLegacyConfig();

  // Dashboard blob split migration (must run before default init)
  migrateDashboardConfigBlob();

  // Ensure dashboard_layouts exists with valid JSON (post-migration)
  const dashLayouts = getConfig('dashboard_layouts');
  if (!dashLayouts || dashLayouts === '' || dashLayouts === 'null') {
    const defaultLayouts = JSON.parse(DEFAULT_DASHBOARD_LAYOUTS_JSON);
    setConfig('dashboard_layouts', JSON.stringify(defaultLayouts));
    setConfig('dashboard_active', 'main');
    logger.info('Initialised default dashboard layouts');
  }

  // Ensure dashboard_active exists
  const activeDash = getConfig('dashboard_active');
  if (!activeDash || activeDash === '') {
    setConfig('dashboard_active', 'main');
  }

  // Also keep dashboard_config for backward compatibility with old code
  // (seeded after migration so existing installs keep their old blob)
  const dashConfig = getConfig('dashboard_config');
  if (!dashConfig || dashConfig === '' || dashConfig === 'null') {
    const defaultConfig = { dashboards: JSON.parse(DEFAULT_DASHBOARD_LAYOUTS_JSON), activeDashboard: 'main' };
    setConfig('dashboard_config', JSON.stringify(defaultConfig));
    logger.info('Initialised default dashboard configuration (legacy blob)');
  }

  // No metric names are bundled: metrics come from the sources you add.
  // Installs from before this change had 35 names seeded; remove the ones
  // nothing has written to or points at (once).
  removeUnusedSeededMetrics();

  logger.info('Database initialized');
}

// The metric names earlier versions seeded into every install.
const FORMER_SEEDED_METRICS = ['Battery Power', 'Battery Voltage', 'Battery Current', 'Battery Runtime', 'Battery Charge Power',
  'Battery Discharge Power', 'Battery Energy (Capacity)', 'Battery Energy (Charge)', 'Battery Energy (Discharge)', 'Battery SOC',
  'Battery Cell Voltage (Lowest)', 'Battery Cell Voltage (Highest)', 'Battery Cell Voltage (Average)', 'Battery Temperature',
  'Grid Voltage', 'Grid Power', 'Grid Current', 'Grid Energy Import', 'Grid Energy Export', 'Grid Status', 'PV Power', 'PV Voltage',
  'PV Energy Generated', 'PV Current', 'PV Forecast Energy', 'Load Power', 'Load Current', 'Load Energy Consumed', 'Load %',
  'Inverter Status', 'Inverter Temperature', 'Ambient Temperature', 'Load Voltage', 'Grid Frequency', 'Load Frequency'];

/**
 * Remove formerly seeded metric names that are unused: no stored readings and
 * not mentioned in any other config value (sources, roles, dashboards,
 * battery banks...). Runs once; anything in use stays.
 */
function removeUnusedSeededMetrics() {
  if (getConfig('seeded_metrics_cleanup_v1') === 'done') return;
  try {
    const list = JSON.parse(getConfig('user_metrics') || '[]');
    if (Array.isArray(list) && list.length) {
      const seeded = new Set(FORMER_SEEDED_METRICS);
      const others = db.prepare("SELECT key, value FROM config WHERE key NOT IN ('user_metrics', 'seeded_metrics_cleanup_v1')").all();
      const hasData = db.prepare('SELECT 1 FROM latest_metrics WHERE metric = ? UNION SELECT 1 FROM metrics WHERE metric = ? LIMIT 1');
      const used = name => others.some(r => typeof r.value === 'string' && (r.value === name || r.value.includes(JSON.stringify(name))))
        || !!hasData.get(name, name);
      const keep = list.filter(m => !(m && seeded.has(m.name)) || used(m.name));
      if (keep.length !== list.length) {
        setConfig('user_metrics', JSON.stringify(keep));
        logger.info(`Removed ${list.length - keep.length} unused bundled metric names`);
      }
    }
  } catch (e) {
    logger.warn('Could not tidy bundled metric names:', e.message);
  }
  setConfig('seeded_metrics_cleanup_v1', 'done');
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

/**
 * Migrate dashboard_config blob to granular keys.
 * Extracts: dashboards→dashboard_layouts, activeDashboard→dashboard_active,
 * and individual flat keys: desktop_dashboard, mobile_dashboard,
 * transparent_blocks, dashboard_bg_color_light, dashboard_bg_color_dark,
 * dashboard_bg_image, grid_status_entity.
 * Old dashboard_config is kept as fallback (dual-read).
 */
function migrateDashboardConfigBlob() {
  const oldBlob = getConfig('dashboard_config');
  if (!oldBlob || oldBlob === '' || oldBlob === 'null') return;

  try {
    const parsed = JSON.parse(oldBlob);
    if (!parsed || typeof parsed !== 'object') return;

    // Only migrate if the new keys are empty (first-run migration)
    const existingLayouts = getConfig('dashboard_layouts');
    if (existingLayouts && existingLayouts !== '' && existingLayouts !== 'null') {
      // Already migrated — skip
      return;
    }

    // Extract dashboards array
    if (parsed.dashboards && Array.isArray(parsed.dashboards)) {
      setConfig('dashboard_layouts', JSON.stringify(parsed.dashboards));
    }

    // Extract activeDashboard
    if (parsed.activeDashboard) {
      setConfig('dashboard_active', parsed.activeDashboard);
    }

    // Extract flat keys from the blob (only if not already set)
    const flatKeys = [
      'desktop_dashboard', 'mobile_dashboard', 'transparent_blocks',
      'dashboard_bg_color_light', 'dashboard_bg_color_dark',
      'dashboard_bg_image', 'grid_status_entity'
    ];
    for (const key of flatKeys) {
      if (parsed[key] !== undefined && parsed[key] !== null) {
        const existing = getConfig(key);
        if (!existing || existing === '') {
          setConfig(key, String(parsed[key]));
        }
      }
    }

    logger.info('Migrated dashboard_config blob to granular keys (old blob preserved for fallback)');
  } catch (err) {
    logger.warn('Failed to migrate dashboard_config blob:', err.message);
  }
}

// SQLite durability (EpilykosOS C-DATA-003 / D-SQLITE-001): set explicitly,
// never left to the library's build default. WAL + NORMAL (the historical
// effective value) cannot corrupt the database on power loss but may drop the
// last few committed transactions; FULL/EXTRA fsync every commit. OFF is
// refused — it trades integrity for speed.
const SYNCHRONOUS_MODES = ['NORMAL', 'FULL', 'EXTRA'];
const DEFAULT_SYNCHRONOUS = 'NORMAL';

function applySynchronousMode(handle) {
  const wanted = String(process.env.SQLITE_SYNCHRONOUS || DEFAULT_SYNCHRONOUS).trim().toUpperCase();
  const mode = SYNCHRONOUS_MODES.includes(wanted) ? wanted : DEFAULT_SYNCHRONOUS;
  if (mode !== wanted) {
    logger.warn(`SQLITE_SYNCHRONOUS=${wanted} is not allowed (use ${SYNCHRONOUS_MODES.join('/')}); using ${mode}`);
  }
  handle.pragma(`synchronous = ${mode}`);
  return mode;
}

/** journal_mode + synchronous as SQLite reports them (for /healthz and diagnostics). */
function getDurabilitySettings() {
  const names = { 0: 'OFF', 1: 'NORMAL', 2: 'FULL', 3: 'EXTRA' };
  const handle = getDb();
  return {
    journal_mode: handle.pragma('journal_mode', { simple: true }),
    synchronous: names[handle.pragma('synchronous', { simple: true })] || 'UNKNOWN'
  };
}

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (!row) return '';
  return decryptConfigValue(key, row.value);
}

function setConfig(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, encryptConfigValue(key, String(value)));
}

// ── At-rest secret encryption (slice B) ────────────────────────────
// WRITE PATH: setConfig() encrypts via encryptConfigValue() below, so every
// caller that funnels through setConfig (migrations in this file, all
// modules/*, server.js setConfig call sites) is covered automatically.
//
// Bulk config writers ENUMERATED (audit 2026-09-15) — all routed through the
// encryption write path (setConfig / encryptConfigValue; $enc1$ envelopes
// pass through idempotently):
// - setConfig (central encrypting writer; migrations, modules/*, server.js
//   call sites auto-covered). Seed INSERT OR IGNORE / UPDATE in
//   initializeDatabase (non-secret '' + defaults only — passthrough).
// - server.js bulk settings save (~L1204): setConfig per key.
// - server.js saveConfigKeys (~L1277): setConfig per key.
// - modules/pvoutput/pull.js pvoutput_config timezone auto-fill:
//   encryptConfigValue on the injected-handle write (api_key envelope
//   preserved verbatim via idempotent passthrough).
//
// READ PATH: getConfig() decrypts symmetric to the write path. One bad field
// never kills a whole read — per-field try/catch returns the field raw + warn.

/**
 * Encrypt `strValue` for storage under `key`. Idempotent (existing $enc1$
 * envelopes pass through). Non-secret keys and empty values pass through.
 * Blob keys with unparseable JSON are stored raw + warn (never brick a save).
 */
function encryptConfigValue(key, strValue) {
  const fields = SECRET_FIELDS[key];
  if (fields === undefined || strValue === '') return strValue;
  if (fields.length === 0) {
    // Top-level scalar secret (e.g. solcast_api_key, mqtt_password, ha_token).
    if (isEncrypted(strValue)) return strValue;
    return encryptString(strValue);
  }
  // Blob key (e.g. tuya_devices, ha_devices, pvoutput_config): encrypt
  // matching leaf fields wherever they appear (objects/arrays recursed,
  // case-insensitive — see modules/encryption.js encryptSecretFields).
  let parsed;
  try {
    parsed = JSON.parse(strValue);
  } catch (_) {
    logger.warn(`encryption: config key '${key}' is not JSON — storing raw`);
    return strValue;
  }
  return JSON.stringify(encryptSecretFields(parsed, fields));
}

/**
 * Inverse of encryptConfigValue: decrypt stored `strValue` for `key`.
 * Non-envelopes pass through (partial-migration safety). Per-field try/catch
 * on blob keys: a corrupt/wrong-key field is returned raw + warn without
 * killing the whole read. Scalar decrypt failure likewise returns raw + warn
 * (resilience at read time; use decryptString directly when a throw is wanted).
 */
function decryptConfigValue(key, strValue) {
  const fields = SECRET_FIELDS[key];
  if (fields === undefined || typeof strValue !== 'string' || strValue === '') return strValue;
  if (fields.length === 0) {
    if (!isEncrypted(strValue)) return strValue;
    try {
      return decryptString(strValue);
    } catch (err) {
      logger.warn(`encryption: scalar key '${key}' failed to decrypt — returning raw: ${err.message}`);
      return strValue;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(strValue);
  } catch (_) {
    return strValue;
  }
  const wanted = new Set(fields.map((f) => String(f).toLowerCase()));
  decryptLeaves(parsed, wanted, key);
  return JSON.stringify(parsed);
}

function decryptLeaves(node, wanted, configKey) {
  if (Array.isArray(node)) {
    // Bare array scalars are never secret leaves (encrypt side only touches
    // keyed leaves) — recurse into objects only.
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (v !== null && typeof v === 'object') decryptLeaves(v, wanted, configKey);
    }
  } else if (node !== null && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v !== null && typeof v === 'object') { decryptLeaves(v, wanted, configKey); continue; }
      if (!wanted.has(String(k).toLowerCase())) continue;
      if (typeof v !== 'string' || !isEncrypted(v)) continue;
      try { node[k] = decryptString(v); }
      catch (err) { logger.warn(`encryption: key '${configKey}' field '${k}' failed to decrypt — returning raw: ${err.message}`); }
    }
  }
}

// NOTE (deploy, 5.9GB prod DB): this migration rewrites config rows in place
// inside ONE transaction — it never copies energy.db and never takes a file
// backup itself. The user runbook file-backup of energy.db precedes deploy.

/**
 * One-time plaintext→$enc1$ migration over SECRET_FIELDS keys present in
 * config. Idempotent (envelopes skipped) — safe to re-run; re-run migrates 0.
 * Runs inside a single transaction. Returns { migrated, skipped }.
 */
function migrateSecretsToEncrypted() {
  if (!getDb()) return { migrated: 0, skipped: 0 };
  const selectAll = getDb().prepare('SELECT key, value FROM config');
  const rows = selectAll.all().filter((r) => Object.prototype.hasOwnProperty.call(SECRET_FIELDS, r.key));
  let migrated = 0;
  let skipped = 0;
  const run = getDb().transaction((list) => {
    const write = getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    for (const { key, value } of list) {
      const fields = SECRET_FIELDS[key];
      let needs = false;
      if (typeof value === 'string' && value !== '') {
        if (fields.length === 0) {
          needs = !isEncrypted(value);
        } else {
          try {
            needs = secretLeafNeedsMigration(JSON.parse(value), new Set(fields.map((f) => String(f).toLowerCase())));
          } catch (_) { needs = false; }
        }
      }
      if (!needs) { skipped++; continue; }
      write.run(key, encryptConfigValue(key, value));
      migrated++;
    }
  });
  run(rows);
  logger.info(`encryption: secrets migration — ${migrated} migrated, ${skipped} already encrypted`);
  return { migrated, skipped };
}

function secretLeafNeedsMigration(node, wanted) {
  if (Array.isArray(node)) {
    return node.some((v) => {
      if (v !== null && typeof v === 'object') return secretLeafNeedsMigration(v, wanted);
      return false; // bare array scalars are not keyed secret leaves
    });
  }
  if (node !== null && typeof node === 'object') {
    return Object.keys(node).some((k) => {
      const v = node[k];
      if (v !== null && typeof v === 'object') return secretLeafNeedsMigration(v, wanted);
      return wanted.has(String(k).toLowerCase())
        && typeof v === 'string' && v !== '' && !isEncrypted(v);
    });
  }
  return false;
}

// ── Metric write queue ─────────────────────────────────────────────
// Bursty poll writers (modbus / HA / Tuya / dongle) enqueue here instead of
// hitting SQLite per-sample; flushMetrics() batch-writes in ONE transaction.
// Flush triggers: 5s auto-flush (server), flush-on-read (modules/metrics.js),
// flushSync() (SIGTERM/SIGINT, tests). Config/grid_status writes are NEVER
// buffered — only metrics/latest_metrics rows go through this queue.
const METRIC_BUFFER_CAP = 500;
// Queued samples reach SQLite at most this long after they are read, so an
// abrupt power cut loses at most this window of telemetry (config/settings
// writes are never queued). EpilykosOS C-DATA-003 cites this value.
const METRIC_FLUSH_INTERVAL_MS = 5000;
let metricBuffer = [];
let metricFlushTimer = null;

function queueMetricWrite(entry) {
  if (!entry || entry.metric === undefined || entry.metric === null) return;
  metricBuffer.push({
    metric: entry.metric,
    value: typeof entry.value === 'number' ? entry.value : null,
    value_text: entry.value_text !== undefined ? entry.value_text : null,
    value_type: entry.value_type !== undefined ? entry.value_type : null,
    unit: entry.unit !== undefined ? entry.unit : null,
    timestamp: (entry.timestamp !== undefined && entry.timestamp !== null)
      ? entry.timestamp : Math.floor(Date.now() / 1000)
  });
  if (metricBuffer.length > METRIC_BUFFER_CAP) {
    const dropped = metricBuffer.length - METRIC_BUFFER_CAP;
    metricBuffer.splice(0, dropped);
    logger.warn(`Metric write buffer overflow: dropped ${dropped} oldest entries (cap ${METRIC_BUFFER_CAP})`);
  }
}

/**
 * Queue one raw source value, classified the way every poller stores it:
 * numeric strings/numbers → `value`; on/off/true/false (and booleans) →
 * value_text with type 'boolean' (lower-cased); anything else → value_text
 * with type 'string'. null/undefined and plain objects are ignored.
 */
function queueMetricValue(metric, rawValue, timestamp, unit) {
  if (rawValue === null || rawValue === undefined) return;
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return;
  const extra = (unit !== undefined && unit !== null) ? { unit } : {};
  const num = parseFloat(rawValue);
  if (!isNaN(num) && num === Number(rawValue)) {
    queueMetricWrite({ metric, value: num, timestamp, ...extra });
    return;
  }
  const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
  const lower = strVal.toLowerCase();
  const isBool = typeof rawValue === 'boolean' || lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false';
  queueMetricWrite({
    metric,
    value: null,
    value_text: isBool ? lower : strVal,
    value_type: isBool ? 'boolean' : 'string',
    timestamp,
    ...extra
  });
}

// Single-transaction batch upsert. Statement shapes mirror the per-module
// writers exactly (numeric 3-col, text 4-col, dongle unit variants).
function flushMetrics() {
  if (metricBuffer.length === 0) return 0;
  const batch = metricBuffer;
  metricBuffer = [];
  const dbm = getDb();
  const metricInsert = dbm.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const metricInsertText = dbm.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  const latestUpsert = dbm.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  const latestUpsertText = dbm.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp) VALUES (?, ?, ?, ?)');
  const latestUpsertUnit = dbm.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)');
  const latestUpsertTextUnit = dbm.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp, unit) VALUES (?, ?, ?, ?, ?)');
  const runBatch = dbm.transaction((rows) => {
    for (const e of rows) {
      if (e.value !== null) {
        metricInsert.run(e.timestamp, e.metric, e.value);
        if (e.unit !== null && e.unit !== undefined) latestUpsertUnit.run(e.metric, e.value, e.timestamp, e.unit);
        else latestUpsert.run(e.metric, e.value, e.timestamp);
      } else {
        metricInsertText.run(e.timestamp, e.metric, e.value_text, e.value_type);
        if (e.unit !== null && e.unit !== undefined) latestUpsertTextUnit.run(e.metric, e.value_text, e.value_type, e.timestamp, e.unit);
        else latestUpsertText.run(e.metric, e.value_text, e.value_type, e.timestamp);
      }
    }
  });
  runBatch(batch);
  return batch.length;
}

function flushSync() {
  return flushMetrics();
}

function clearMetricBuffer() {
  const n = metricBuffer.length;
  metricBuffer = [];
  return n;
}

function getMetricBufferSize() {
  return metricBuffer.length;
}

function startMetricAutoFlush(intervalMs = METRIC_FLUSH_INTERVAL_MS) {
  if (metricFlushTimer) return metricFlushTimer;
  metricFlushTimer = setInterval(() => {
    try { flushMetrics(); } catch (err) { logger.warn('Metric auto-flush failed:', err.message); }
  }, intervalMs);
  if (typeof metricFlushTimer.unref === 'function') metricFlushTimer.unref();
  return metricFlushTimer;
}

function stopMetricAutoFlush() {
  if (metricFlushTimer) { clearInterval(metricFlushTimer); metricFlushTimer = null; }
}

/**
 * Settings pages receive saved secrets still encrypted ($enc1$…) and send
 * them back as-is when a Test / Fetch button is pressed. Swap such a value
 * for the real secret, but only when it's one this server stored under one
 * of `configKeys`; anything else passes through untouched.
 * @param {*} value - value from a request body
 * @param {string[]} configKeys - config keys whose stored secrets may match
 */
function resolveStoredSecret(value, configKeys) {
  if (typeof value !== 'string' || !isEncrypted(value)) return value;
  for (const key of configKeys) {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
    if (row && typeof row.value === 'string' && row.value.includes(value)) {
      try { return decryptString(value); } catch (err) { logger.warn(`encryption: stored secret for '${key}' failed to decrypt: ${err.message}`); return value; }
    }
  }
  return value;
}

module.exports = {
  DEFAULT_DASHBOARD_LAYOUTS_JSON,
  initializeDatabase,
  migratePowerStatsSchema,
  resolveStoredSecret,
  getConfig,
  setConfig,
  encryptConfigValue,
  migrateSecretsToEncrypted,
  getDb,
  getDurabilitySettings,
  DB_PATH,
  queueMetricWrite,
  queueMetricValue,
  flushMetrics,
  flushSync,
  clearMetricBuffer,
  getMetricBufferSize,
  startMetricAutoFlush,
  stopMetricAutoFlush,
  METRIC_BUFFER_CAP,
  METRIC_FLUSH_INTERVAL_MS
};
