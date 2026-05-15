const { getConfig, setConfig, getDb } = require('./database');
const { logger } = require('./logger');

// Get all metrics (from latest_metrics + user_metrics)
function getAllMetrics() {
  const db = getDb();
  const latest = db.prepare('SELECT metric, value, timestamp FROM latest_metrics').all();
  const userMetrics = JSON.parse(getConfig('user_metrics') || '[]');
  const metricMap = new Map();

  // Add metrics with values
  latest.forEach(m => {
    metricMap.set(m.metric, {
      name: m.metric,
      value: m.value,
      timestamp: m.timestamp,
      unit: null
    });
  });

  // Add user-created metrics (may not have values yet)
  userMetrics.forEach(m => {
    if (!metricMap.has(m.name)) {
      metricMap.set(m.name, {
        name: m.name,
        value: null,
        timestamp: null,
        unit: m.unit || ''
      });
    } else {
      // Update unit for existing metric if user-defined
      const existing = metricMap.get(m.name);
      existing.unit = m.unit || existing.unit;
    }
  });

  return Array.from(metricMap.values());
}

function createMetric(name, unit) {
  if (!name || name.trim() === '') throw new Error('Metric name is required');
  const userMetrics = JSON.parse(getConfig('user_metrics') || '[]');
  if (userMetrics.some(m => m.name === name)) throw new Error(`Metric "${name}" already exists`);
  userMetrics.push({ name, unit: unit || '', createdAt: Date.now() });
  setConfig('user_metrics', JSON.stringify(userMetrics));
  logger.info(`Created new metric: ${name}`);
}

function deleteMetric(name) {
  // 1. Remove from user_metrics config
  let userMetrics = JSON.parse(getConfig('user_metrics') || '[]');
  const originalLength = userMetrics.length;
  userMetrics = userMetrics.filter(m => m.name !== name);
  if (userMetrics.length === originalLength) {
    logger.debug(`Metric "${name}" not found in user_metrics, attempting cleanup anyway`);
  }
  setConfig('user_metrics', JSON.stringify(userMetrics));

  // 2. Remove from latest_metrics and metrics tables
  const db = getDb();
  db.prepare('DELETE FROM latest_metrics WHERE metric = ?').run(name);
  db.prepare('DELETE FROM metrics WHERE metric = ?').run(name);

  // 3. Remove from HA device mappings
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  let haChanged = false;
  haDevices.forEach(device => {
    if (device.entities && device.entities[name]) {
      delete device.entities[name];
      haChanged = true;
    }
  });
  if (haChanged) setConfig('ha_devices', JSON.stringify(haDevices));

  // 4. Remove from MQTT device topic mappings
  const mqttDevices = JSON.parse(getConfig('mqtt_devices') || '[]');
  let mqttChanged = false;
  mqttDevices.forEach(device => {
    if (device.topics && device.topics[name]) {
      delete device.topics[name];
      mqttChanged = true;
    }
  });
  if (mqttChanged) setConfig('mqtt_devices', JSON.stringify(mqttDevices));

  // 5. Remove from external sources mappings
  const externalSources = JSON.parse(getConfig('external_sources') || '[]');
  let extChanged = false;
  externalSources.forEach(src => {
    if (src.mappings) {
      for (const [jsonPath, metricName] of Object.entries(src.mappings)) {
        if (metricName === name) {
          delete src.mappings[jsonPath];
          extChanged = true;
        }
      }
    }
  });
  if (extChanged) setConfig('external_sources', JSON.stringify(externalSources));

  logger.info(`Deleted metric: ${name}`);
}

module.exports = { getAllMetrics, createMetric, deleteMetric };
