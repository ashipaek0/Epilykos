const { logger } = require('./logger');
const mqtt = require('mqtt');
const { getConfig, queueMetricWrite } = require('./database');

const mqttClients = new Map();

function saveMetric(metricName, rawValue, timestamp) {
  const num = parseFloat(rawValue);
  if (!isNaN(num) && num === Number(rawValue)) {
    queueMetricWrite({ metric: metricName, value: num, timestamp });
  } else {
    const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
    const lower = strVal.toLowerCase();
    const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
    const type = isBool ? 'boolean' : 'string';
    const displayVal = isBool ? lower : strVal;
    queueMetricWrite({ metric: metricName, value: null, value_text: displayVal, value_type: type, timestamp });
  }
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
      logger.info(`MQTT connected to ${device.broker}`);
      const topics = Object.values(device.topics || {}).filter(t => t);
      if (topics.length) client.subscribe(topics);
    });

    client.on('message', (topic, message) => {
      const msg = message.toString().trim();
      const topicMap = device.topics || {};
      let metric;
      for (const [key, t] of Object.entries(topicMap)) {
        if (t === topic) { metric = key; break; }
      }
      if (!metric) return;
      const now = Math.floor(Date.now() / 1000);
      saveMetric(metric, msg, now);
    });

    client.on('error', (err) => logger.error(`MQTT ${device.broker} error:`, err));
  }
}

function restartMqtt() { setupMqtt(); }

function executeMqttAction(brokerName, topic, payload) {
  const client = mqttClients?.get(brokerName);
  if (!client) return { error: `MQTT broker "${brokerName}" not connected` };
  if (!client.connected) return { success: false, error: 'MQTT client not connected' };

  try {
    client.publish(topic, String(payload ?? ''), { qos: 1 });
    logger.debug(`MQTT published to ${brokerName}/${topic}: ${payload}`);
    return { success: true };
  } catch (e) {
    logger.error(`MQTT action error for ${brokerName}/${topic}: ${e.message}`);
    return { error: e.message };
  }
}

module.exports = { setupMqtt, restartMqtt, mqttClients, executeMqttAction };
