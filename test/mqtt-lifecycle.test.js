'use strict';
const checks = require('./_checks');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-mqtt-lifecycle-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const clients = [];
const mqttPath = require.resolve('mqtt');
require(mqttPath);
require.cache[mqttPath].exports = { connect(broker, opts) {
  const client = new EventEmitter();
  Object.assign(client, { broker, opts, connected: true, subscriptions: [], publications: [],
    subscribe(topics) { this.subscriptions.push(topics); },
    publish(topic, payload) { this.publications.push({ topic, payload }); },
    end() { this.disconnecting = true; this.ended = true; this.emit('close'); },
  });
  clients.push(client);
  return client;
} };
const mqtt = require('../modules/mqtt');
const { onEvent } = require('../modules/notifications/events');
const events = [];
const unsubscribe = onEvent(e => events.push(e.type));
const broker = 'mqtt://broker.example';
const device = (name, topics, username = 'shared') => ({ name, broker, enabled: true, username, topics });
try {
  database.setConfig('mqtt_devices', JSON.stringify([device('A', { a: 'same', first: 'first' }), device('B', { b: 'same', second: 'second' })]));
  mqtt.setupMqtt();
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(mqtt.mqttClients.size, 1);
  clients[0].emit('connect');
  assert.deepStrictEqual(clients[0].subscriptions, [['same', 'first', 'second']]);
  clients[0].emit('message', 'same', Buffer.from('42'));
  database.flushMetrics();
  const read = name => database.getDb().prepare('SELECT value FROM latest_metrics WHERE metric = ?').get(name)?.value;
  assert.strictEqual(read('a'), 42);
  assert.strictEqual(read('b'), 42);
  mqtt.restartMqtt();
  assert.strictEqual(clients.length, 2);
  assert.strictEqual(clients[0].ended, true);
  assert.deepStrictEqual(events, [], 'our restart must not issue an outage notification');
  clients[0].emit('message', 'same', Buffer.from('99'));
  database.flushMetrics();
  assert.strictEqual(read('a'), 42, 'retired connections cannot write metrics');

  database.setConfig('mqtt_devices', JSON.stringify([device('A', { a: 'first' }, 'one'), device('B', { b: 'second' }, 'two')]));
  mqtt.restartMqtt();
  assert.strictEqual(mqtt.mqttClients.size, 2, 'different credentials retain independent connections');
  const first = clients.at(-2), second = clients.at(-1);
  assert.strictEqual(mqtt.executeMqttAction(broker, 'second', 'ON').success, true);
  assert.deepStrictEqual(first.publications, []);
  assert.deepStrictEqual(second.publications, [{ topic: 'second', payload: 'ON' }]);
  second.emit('connect');
  second.emit('close');
  second.emit('close');
  second.emit('connect');
  assert.deepStrictEqual(events, ['mqtt.disconnected', 'mqtt.connected']);
  database.setConfig('mqtt_devices', '[]');
  mqtt.restartMqtt();
  assert.ok(clients.every(c => c.ended), 'every connection closed, including shared-broker credential groups');
  assert.strictEqual(mqtt.mqttClients.size, 0);
  console.log('ok - MQTT shared brokers preserve mappings, credentials and connection lifecycle');
  checks.done();
} finally { unsubscribe(); database.getDb().close(); }
