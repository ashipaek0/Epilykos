'use strict';

/**
 * Tuya switches on toggle cards: every mapped DP is listed for the editor
 * (even before its first reading), the card sends Tuya the new on/off value
 * (it could only switch on before), HA gets no extra service data, and a
 * Tuya device missing its LAN IP or local key is reported, not skipped.
 *
 * Isolation: scratch cwd (DB_PATH is cwd-relative) and ENC_KEY_FILE.
 * Run: node --test test/tuya-switches.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-tuya-switches-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');

const database = require('../modules/database');
database.initializeDatabase();
const config = (key, value) => database.setConfig(key, JSON.stringify(value));

// The Tuya bridge is a Python child process: record calls instead.
const bridgeCalls = [];
const childProcess = require('node:child_process');
childProcess.execFile = (file, args, opts, callback) => { bridgeCalls.push(args); callback(null, JSON.stringify({ '1': true }), ''); };

const { switchableEntities } = require('../modules/switchables');
const tuya = require('../modules/tuya');

test('every mapped Tuya DP, HA switch-like entity and MQTT topic is listed', () => {
  config('tuya_devices', [
    { name: 'Fridge', dev_id: 'bf1', address: '192.168.1.50', local_key: 'k', enabled: true, dps: { 'Fridge Switch': 1 } },
    { name: 'Off', dev_id: 'bf9', address: '192.168.1.51', local_key: 'k', enabled: false, dps: { 'Off Switch': 1 } },
  ]);
  config('ha_devices', [{ name: 'Home', enabled: true, entities: { 'Porch Light': 'light.porch', 'Outdoor Temp': { entityId: 'sensor.outdoor' } } }]);
  config('mqtt_devices', [{ name: 'Plug', broker: 'mqtt://b', enabled: true, topics: { 'Plug State': 'plug/state' } }]);
  const list = switchableEntities();
  assert.deepStrictEqual(list.map(s => [s.source, s.device, s.entity, s.metric, s.action]), [
    ['tuya', 'Fridge', 'Fridge Switch', 'Fridge Switch', 'switch.toggle'],
    ['ha', 'Home', 'light.porch', 'Porch Light', 'light.toggle'],
    ['mqtt', 'mqtt://b', 'plug/state', 'Plug State', 'toggle'],
  ]);
});

test('the toggle card sends Tuya the new state, and nothing extra to HA', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/components/switchBlock.js'), 'utf8');
  assert.match(src, /this\.dataset\.source === 'tuya' \? \{ params: \{ value: this\.checked \} \} : \{\}/);
  assert.match(src, /container\.dataset\.metric = config\.metric \|\| config\.entity/);
  const editor = fs.readFileSync(path.join(ROOT, 'public/js/editor.js'), 'utf8');
  assert.match(editor, /fetch\('\/api\/switchable-entities'\)/);
  assert.match(editor, /fetch\('\/api\/metrics\/list'\)/, 'metrics with no reading yet are offered too');
});

test('a Tuya device without LAN IP or local key is reported, not skipped silently', async () => {
  config('tuya_devices', [
    { name: 'Server', dev_id: 'bf2', address: '', local_key: 'k', enabled: true, dps: { 'Server Switch': 1 } },
    { name: 'Fridge', dev_id: 'bf1', address: '192.168.1.50', local_key: 'k', enabled: true, dps: { 'Fridge Switch': 1 } },
  ]);
  bridgeCalls.length = 0;
  const result = await tuya.pollTuyaDevices();
  assert.strictEqual(result.attempted, 2);
  assert.deepStrictEqual(result.errors.map(e => e.message), ['"Server" has no LAN IP']);
  assert.strictEqual(bridgeCalls.length, 1, 'only the complete device is polled');
});
