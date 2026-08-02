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
  if (!isNaN(num) && String(num) === String(rawValue).trim()) {
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
  return data.filter(e => e.entity_id.startsWith('sensor.') || e.entity_id.startsWith('binary_sensor.')).map(e => e.entity_id);
}

module.exports = { pollHomeAssistant, fetchHAEntities, mqttValues };
