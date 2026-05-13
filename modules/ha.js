const fetch = require('node-fetch');
const { getConfig, db } = require('./database');

let mqttValues = {}; // still used as fallback

async function pollHomeAssistant() {
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  if (!haDevices.length) return;

  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');

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
        const val = parseFloat(data.state);
        if (isNaN(val)) continue;
        const now = Math.floor(Date.now() / 1000);
        metricInsert.run(now, metric, val);
        latestUpsert.run(metric, val, now);
        mqttValues[metric] = val;
      } catch (e) { /* silent */ }
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
