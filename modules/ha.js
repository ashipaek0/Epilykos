const { logger } = require('./logger');
const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');

let metricInsertStmt = null;
let latestUpsertStmt = null;
let metricInsertTextStmt = null;
let latestUpsertTextStmt = null;

function getMetricInsert() {
  if (!metricInsertStmt) {
    const db = getDb();
    metricInsertStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  }
  return metricInsertStmt;
}

function getLatestUpsert() {
  if (!latestUpsertStmt) {
    const db = getDb();
    latestUpsertStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  }
  return latestUpsertStmt;
}

function getMetricInsertText() {
  if (!metricInsertTextStmt) {
    const db = getDb();
    metricInsertTextStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  }
  return metricInsertTextStmt;
}

function getLatestUpsertText() {
  if (!latestUpsertTextStmt) {
    const db = getDb();
    latestUpsertTextStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp) VALUES (?, ?, ?, ?)');
  }
  return latestUpsertTextStmt;
}

function saveMetric(metricName, rawValue, timestamp) {
  const num = parseFloat(rawValue);
  if (!isNaN(num) && num === Number(rawValue)) {
    getLatestUpsert().run(metricName, num, timestamp);
    getMetricInsert().run(timestamp, metricName, num);
  } else {
    const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
    const lower = strVal.toLowerCase();
    const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
    const type = isBool ? 'boolean' : 'string';
    const displayVal = isBool ? lower : strVal;
    getLatestUpsertText().run(metricName, displayVal, type, timestamp);
    getMetricInsertText().run(timestamp, metricName, displayVal, type);
  }
}

let mqttValues = {};

async function pollHomeAssistant() {
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  if (!haDevices.length) return;

  for (const device of haDevices) {
    if (!device.enabled || !device.url || !device.token) continue;
    for (const [metric, entityId] of Object.entries(device.entities)) {
      if (!entityId) continue;
      try {
        const res = await fetch(`${device.url}/api/states/${entityId}`, {
          headers: { 'Authorization': `Bearer ${device.token}` },
          timeout: 5000
        });
        if (!res.ok) continue;
        const data = await res.json();
        const now = Math.floor(Date.now() / 1000);
        saveMetric(metric, data.state, now);
        // Store numeric representation for mqttValues compatibility
        const num = parseFloat(data.state);
        mqttValues[metric] = !isNaN(num) ? num : (data.state === 'on' || data.state === 'true' ? 1 : (data.state === 'off' || data.state === 'false' ? 0 : undefined));
      } catch (e) {
        logger.warn(`HA poll error for ${device.name} - ${metric}: ${e.message}`);
      }
    }
  }
}

async function fetchHAEntities(url, token) {
  const response = await fetch(`${url}/api/states`, {
    headers: { 'Authorization': `Bearer ${token}` },
    timeout: 5000
  });
  if (!response.ok) throw new Error(`HA error ${response.status}`);
  const data = await response.json();
  return data.filter(e => 
    e.entity_id.startsWith('sensor.') || 
    e.entity_id.startsWith('binary_sensor.') ||
    e.entity_id.startsWith('switch.') ||
    e.entity_id.startsWith('light.') ||
    e.entity_id.startsWith('climate.') ||
    e.entity_id.startsWith('fan.') ||
    e.entity_id.startsWith('cover.') ||
    e.entity_id.startsWith('input_boolean.')
  ).map(e => e.entity_id);
}

async function executeHAAction(deviceName, entityId, service, data = {}) {
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  const device = haDevices.find(d => d.name === deviceName);
  if (!device || !device.enabled) return { error: 'Device not found or disabled' };
  if (!device.url || !device.token) return { error: 'Device URL or token missing' };
  
  const [domain, serviceName] = service.split('.');
  if (!domain || !serviceName) return { error: 'Invalid service format (domain.service)' };
  
  try {
    const res = await fetch(`${device.url}/api/services/${domain}/${serviceName}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: entityId, ...data }),
      timeout: 5000
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { error: `HA returned ${res.status}: ${errText}` };
    }
    const result = await res.json();
    return { success: true, result };
  } catch (e) {
    logger.error(`HA action error for ${deviceName}/${entityId}: ${e.message}`);
    return { error: e.message };
  }
}

const DOMAIN_ACTIONS = {
  'switch': [{ service: 'switch.toggle', label: 'Toggle', type: 'toggle' }],
  'light': [
    { service: 'light.toggle', label: 'Toggle', type: 'toggle' },
    { service: 'light.turn_on', label: 'Turn On', type: 'set_brightness', param: 'brightness_pct' }
  ],
  'climate': [
    { service: 'climate.set_hvac_mode', label: 'Set Mode', type: 'select', param: 'hvac_mode' },
    { service: 'climate.set_temperature', label: 'Set Temperature', type: 'number', param: 'temperature' }
  ],
  'fan': [
    { service: 'fan.toggle', label: 'Toggle', type: 'toggle' },
    { service: 'fan.set_preset_mode', label: 'Set Speed', type: 'select', param: 'preset_mode' }
  ],
  'cover': [
    { service: 'cover.open_cover', label: 'Open', type: 'button' },
    { service: 'cover.close_cover', label: 'Close', type: 'button' },
    { service: 'cover.stop_cover', label: 'Stop', type: 'button' }
  ],
  'input_boolean': [{ service: 'input_boolean.toggle', label: 'Toggle', type: 'toggle' }]
};

function getEntityActions(entityId) {
  const dotIndex = entityId.indexOf('.');
  if (dotIndex === -1) return [];
  const domain = entityId.substring(0, dotIndex);
  return DOMAIN_ACTIONS[domain] || [];
}

module.exports = { pollHomeAssistant, fetchHAEntities, mqttValues, executeHAAction, getEntityActions };
