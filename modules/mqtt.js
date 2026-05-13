const mqtt = require('mqtt');
const { getConfig, getDb } = require('./database');

const mqttClients = new Map();

let latestUpsertStmt = null;
let metricInsertStmt = null;

function getLatestUpsert() {
  if (!latestUpsertStmt) {
    const db = getDb();
    latestUpsertStmt = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  }
  return latestUpsertStmt;
}

function getMetricInsert() {
  if (!metricInsertStmt) {
    const db = getDb();
    metricInsertStmt = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  }
  return metricInsertStmt;
}

function setupMqtt() {
  for (const client of mqttClients.values()) client.end();
  mqttClients.clear();

  const mqttDevices = JSON.parse(getConfig('mqtt_devices') || '[]');
  if (!mqttDevices.length) return;

  for (const device of mqttDevices) {
    if (!device.enabled || !device.broker) continue;
    const opts = {};
    if (device.username) opts.username = device.username;
    if (device.password) opts.password = device.password;

    const client = mqtt.connect(device.broker, opts);
    mqttClients.set(device.broker, client);

    client.on('connect', () => {
      console.log(`MQTT connected to ${device.broker}`);
      const topics = Object.values(device.topics || {}).filter(t => t);
      if (topics.length) client.subscribe(topics);
    });

    client.on('message', (topic, message) => {
      const val = parseFloat(message.toString());
      if (isNaN(val)) return;
      const topicMap = device.topics || {};
      let metric;
      for (const [key, t] of Object.entries(topicMap)) {
        if (t === topic) { metric = key; break; }
      }
      if (!metric) return;
      const now = Math.floor(Date.now() / 1000);
      getLatestUpsert().run(metric, val, now);
      getMetricInsert().run(now, metric, val);
    });

    client.on('error', (err) => console.error(`MQTT ${device.broker} error:`, err));
  }
}

function restartMqtt() { setupMqtt(); }

module.exports = { setupMqtt, restartMqtt, mqttClients };
