/**
 * Settings routes (mounted at /api): reading every saved setting, and saving them whole or one section at a time
 * (data sources, metrics, dashboard, solar, savings, branding, network), plus recalculating the savings history.
 * Signed-in only. Secrets, first-run state, update and remote-access keys, and notification keys are refused here
 * (each has its own stricter route); saving restarts only the pollers whose keys changed.
 *
 * @module routes/settings
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, setConfig, getDb } = require('../modules/database');
const { isAuthenticated } = require('../modules/sessionAuth');
const { validateNumericConfig } = require('../modules/configValidation');
const { shouldInvalidateForecastCache, clearForecastCache } = require('../modules/solar');
const { updateInverterMetrics } = require('../modules/inverterSetup');
const pvoutput = require('../modules/pvoutput');
const { restartMqtt } = require('../modules/mqtt');
const { restartExternalPolling } = require('../modules/external');
const { restartBmsPolling } = require('../modules/bms');
const { restartBmsWiredPolling } = require('../modules/bmsWired');
const { restartDonglePolling } = require('../modules/dongle');
const { restartRs232Streaming } = require('../modules/rs232');

const router = express.Router();

router.use('/settings', isAuthenticated);
router.get('/settings', (req, res) => {
  const rows = getDb().prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});

router.post('/settings', (req, res) => {
  const updates = req.body;
  try {
    const invalidNum = validateNumericConfig(updates);
    if (invalidNum) return res.status(400).json({ error: invalidNum });
    // Reject keys matching sensitive patterns (token, password, secret, key, etc.)
    const sensitivePattern = /_token$|_password$|_secret$/i;
    const sensitiveKeyExempt = ['tuya_cloud'];
    const filteredUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      if (sensitivePattern.test(key) && !sensitiveKeyExempt.includes(key)) {
        logger.warn(`[Settings] Rejected sensitive key: ${key}`);
        continue;
      }
      // Keys with their own stricter route (device writes, first-run state, updates, remote access).
      if (require('../modules/protectedConfig').isProtectedKey(key)) {
        logger.warn(`[Settings] Rejected protected key: ${key}`);
        continue;
      }
      // Notification channels, rules, devices and keys are written only by /api/notifications.
      if (key.startsWith('notification_')) {
        logger.warn(`[Settings] Rejected notification key (use /api/notifications): ${key}`);
        continue;
      }
      filteredUpdates[key] = value;
    }
    if (filteredUpdates.dongle_config !== undefined) {
      let devices = filteredUpdates.dongle_config;
      if (typeof devices === 'string') { try { devices = JSON.parse(devices || '[]'); } catch (_) { devices = []; } }
      const clash = require('../modules/sourceChecks').dongleNameClash(devices);
      if (clash) return res.status(400).json({ error: clash });
    }
    if (filteredUpdates.bms_banks !== undefined) {
      let banks = filteredUpdates.bms_banks;
      if (typeof banks === 'string') { try { banks = JSON.parse(banks || '[]'); } catch (_) { banks = []; } }
      const clash = require('../modules/sourceChecks').bankOutputClash(banks);
      if (clash) return res.status(400).json({ error: clash });
    }
    const oldBanksRaw = getConfig('bms_banks'); // snapshot BEFORE the save for orphan cleanup
    const saved = [];
    for (const [key, value] of Object.entries(filteredUpdates)) {
      // Reject undefined values; coerce null to empty string
      if (value === undefined) continue;
      const safeValue = value === null ? '' : String(value);
      setConfig(key, key === 'pvoutput_config' ? pvoutput.keepWebhookToken(safeValue) : safeValue); // encrypt-at-write ($enc1$ passthrough)
      saved.push(key);
    }
    applySourceConfigChanges(saved, oldBanksRaw);
    if (shouldInvalidateForecastCache(saved)) clearForecastCache();
    try { require('./logs').refreshSecrets(); } catch (_) { /* logs not ready */ }
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
 * Restart the pollers whose config keys were just saved. For bms_banks, also
 * delete bank_* metrics the new config no longer produces and pre-create the
 * ones it does. `oldBanksRaw` must be read BEFORE the save.
 * @param {string[]} savedKeys
 * @param {string} oldBanksRaw - previous bms_banks JSON
 */
function applySourceConfigChanges(savedKeys, oldBanksRaw) {
  const has = (k) => savedKeys.includes(k);
  if (has('mqtt_devices')) restartMqtt();
  if (has('external_sources') || has('external_poll_interval')) restartExternalPolling();
  if (has('bms_banks')) {
    const { cleanupOrphanedBankMetrics } = require('../modules/bmsAggregator');
    const { createMetric } = require('../modules/metricsManager');
    const parseBanks = (raw) => {
      try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
    };
    const newBanks = parseBanks(getConfig('bms_banks'));
    cleanupOrphanedBankMetrics(parseBanks(oldBanksRaw), newBanks);
    for (const bank of newBanks) {
      const safeName = String(bank.name || '').replace(/[^a-zA-Z0-9_]/g, '_');
      const names = (bank.functions || []).map(fn => `bank_${fn.output}`)
        .concat([`bank_${safeName}_devices_online`, `bank_${safeName}_last_update`]);
      for (const name of names) {
        try { createMetric(name, ''); } catch (_) { /* already exists */ }
      }
    }
  }
  if (has('bms_devices') || has('dongle_config')) require('../modules/ble').updateMaxLinks();
  if (has('bms_devices') || has('bms_banks')) {
    restartBmsPolling();
    restartBmsWiredPolling();
  }
  if (has('dongle_config')) { updateInverterMetrics(); restartDonglePolling(); }
  if (has('pvoutput_config')) pvoutput.restart();
  if (has('rs232_devices')) restartRs232Streaming();
}

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
      const raw = updates[key];
      // Reject undefined values (missing/unset) to avoid "undefined" strings in DB
      if (raw === undefined) continue;
      // Coerce null to empty string instead of "null"
      const value = raw === null ? '' : String(raw);
      filtered[key] = value;
    }
  }
  const saved = [];
  for (const [key, value] of Object.entries(filtered)) {
    setConfig(key, key === 'pvoutput_config' ? pvoutput.keepWebhookToken(value) : value); // encrypt-at-write ($enc1$ passthrough)
    saved.push(key);
  }
  try { require('./logs').refreshSecrets(); } catch (_) { /* logs not ready */ }   // new secrets are hidden in logs at once
  return { saved };
}

// Data sources: ha_devices, mqtt_devices, modbus_devices, rs232_devices,
// external_sources, bms_devices, bms_banks, dongle_config, pvoutput_config
router.post('/settings/data-sources', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'ha_devices', 'mqtt_devices', 'modbus_devices', 'rs232_devices',
      'external_sources', 'external_poll_interval',
      'bms_devices', 'bms_banks', 'dongle_config', 'pvoutput_config',
      'tuya_devices', 'tuya_cloud', 'setup_probe_cache'
    ];
    // The page Settings uses: refuse inverters that would overwrite each
    // other's metrics here too, not only on the older /api/settings.
    if (req.body && req.body.dongle_config !== undefined) {
      let devices = req.body.dongle_config;
      if (typeof devices === 'string') { try { devices = JSON.parse(devices || '[]'); } catch (_) { devices = []; } }
      const clash = require('../modules/sourceChecks').dongleNameClash(devices);
      if (clash) return res.status(400).json({ error: clash });
    }
    const oldBanksRaw = getConfig('bms_banks'); // snapshot BEFORE the save for orphan cleanup
    const { saved } = saveConfigKeys(allowed, req, res);
    applySourceConfigChanges(saved, oldBanksRaw);

    logger.info(`[Settings/data-sources] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/data-sources] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Metrics: user_metrics only
router.post('/settings/metrics', isAuthenticated, (req, res) => {
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
router.post('/settings/dashboard', isAuthenticated, (req, res) => {
  try {
    const allowed = [
      'dashboard_layouts', 'dashboard_active',
      'desktop_dashboard', 'mobile_dashboard', 'public_dashboards', 'tabs_position', 'transparent_blocks', 'square_corners', 'glass_cards', 'glass_blur', 'glass_frost',
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
router.post('/settings/solar', isAuthenticated, (req, res) => {
  try {
    const invalid = validateNumericConfig(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const allowed = [
      'forecast_enabled', 'solar_latitude', 'solar_longitude', 'solar_tilt',
      'solar_azimuth', 'solar_capacity_kwp', 'solcast_api_key', 'solcast_resource_id', 'solar_arrays',
      'solar_loss_factor', 'solar_install_date',
      'forecast_default_source', 'weather_default_source', 'solcast_daily_limit', 'solcast_weather', 'role_metrics'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);
    if (shouldInvalidateForecastCache(saved)) clearForecastCache();
    logger.info(`[Settings/solar] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/solar] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Savings: savings_* keys
router.post('/settings/savings', isAuthenticated, (req, res) => {
  try {
    const invalid = validateNumericConfig(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const allowed = [
      'savings_currency', 'savings_rate', 'savings_solar_metric',
      'all_time_pv_savings_override',
      'energy_sell_price', 'battery_wear_cost', 'battery_capacity_kwh', 'battery_min_soc',
      'generator_price', 'savings_method', 'grid_status_entity', 'generator_status_entity'
    ];
    const { saved } = saveConfigKeys(allowed, req, res);
    logger.info(`[Settings/savings] Saved: ${saved.join(', ')}`);
    res.json({ ok: true, saved });
  } catch (err) {
    logger.error('[Settings/savings] Save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Savings: count every finished day again at the current prices
// (Settings > Prices and savings > Recalculate history). Finished days otherwise
// keep the value they had when they were counted (modules/solarValue.js).
let recalculatingSavings = false;
router.post('/savings/recalculate', isAuthenticated, (req, res) => {
  if (recalculatingSavings) return res.status(409).json({ error: 'Already recalculating' });
  recalculatingSavings = true;
  try {
    const { recalculateSavingsHistory, computeSavings } = require('../modules/solarValue');
    const { computeTodaySolar } = require('../modules/solar');
    recalculateSavingsHistory(getDb());
    const s = computeSavings({ todaySolarKwh: computeTodaySolar({ fresh: true }) });
    logger.info('[savings] History recalculated at the current prices');
    res.json({ ok: true, all: s.all, year: s.year, month: s.month, currency: s.currency });
  } catch (err) {
    logger.error('[savings] Recalculate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    recalculatingSavings = false;
  }
});

// Branding: dashboard appearance
router.post('/settings/branding', isAuthenticated, (req, res) => {
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
router.post('/settings/network', isAuthenticated, (req, res) => {
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
router.post('/settings/backup', isAuthenticated, (req, res) => {
  res.json({ ok: true, saved: [] });
});

module.exports = router;
