const { logger } = require('./logger');
const mqtt = require('mqtt');
const { getConfig, queueMetricValue } = require('./database');
const { emitEvent } = require('./notifications/events');

/** Broker address without credentials, for alerts. */
function brokerLabel(broker) {
  try { const u = new URL(broker); return u.host || broker; } catch (_) { return String(broker).replace(/\/\/[^@/]*@/, '//'); }
}

const mqttClients = new Map();

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

    // Alert on a drop of an established connection, and on its recovery —
    // not on every failed reconnect attempt, nor on our own end() at restart.
    let dropped = false;
    let wasConnected = false;
    client.on('connect', () => {
      logger.info(`MQTT connected to ${device.broker}`);
      wasConnected = true;
      if (dropped) {
        dropped = false;
        emitEvent('mqtt.connected', { subject: brokerLabel(device.broker), message: `MQTT broker ${brokerLabel(device.broker)} is connected again.` });
      }
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
      queueMetricValue(metric, msg, now);
    });

    client.on('error', (err) => logger.error(`MQTT ${device.broker} error:`, err));
    client.on('close', () => {
      if (client.disconnecting || !wasConnected || dropped) return;
      dropped = true;
      emitEvent('mqtt.disconnected', { subject: brokerLabel(device.broker), message: `Lost the connection to MQTT broker ${brokerLabel(device.broker)}.` });
    });
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
