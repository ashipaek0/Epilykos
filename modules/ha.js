const { logger } = require('./logger');
const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');

let metricInsertStmt = null;
let latestUpsertStmt = null;

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
        let val = parseFloat(data.state);
        if (isNaN(val)) {
          // Handle binary sensors returning on/off strings
          if (data.state === 'on') val = 1;
          else if (data.state === 'off') val = 0;
          else continue;
        }
        const now = Math.floor(Date.now() / 1000);
        getMetricInsert().run(now, metric, val);
        getLatestUpsert().run(metric, val, now);
        mqttValues[metric] = val;
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
