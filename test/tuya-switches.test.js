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
let bridgeFails = false;
childProcess.execFile = (file, args, opts, callback) => {
  bridgeCalls.push(args);
  if (bridgeFails) {
    const err = new Error(`Command failed: python3 -u ${args.join(' ')}`);
    err.code = 1;
    return callback(err, '', 'Traceback (most recent call last):\n  File "tuya_bridge.py", line 141\nValueError: invalid literal for int() with base 10: \'x\'');
  }
  callback(null, JSON.stringify({ '1': true }), '');
};

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

test('selectors get Tuya DPs, HA select/climate entities and MQTT topics', () => {
  config('ha_devices', [{ name: 'Home', enabled: true, entities: { 'AC Mode': 'climate.bedroom', 'Scene': 'select.scene', 'Porch Light': 'light.porch' } }]);
  const sel = switchableEntities().filter(s => s.selectAction).map(s => [s.source, s.entity, s.selectAction]);
  assert.deepStrictEqual(sel.filter(s => s[0] === 'ha'), [['ha', 'climate.bedroom', 'climate.set_hvac_mode'], ['ha', 'select.scene', 'select.select_option']]);
  assert.ok(sel.some(s => s[0] === 'tuya'), 'Tuya DPs can be selectors (enum modes)');
});

test('a bridge failure never shows the local key, only the Python error', async () => {
  config('tuya_devices', [{ name: 'AC', dev_id: 'eb0f95026f34dbce3fwtrb', address: '192.168.0.151', local_key: 'xGS9-not-a-real-key', enabled: true, dps: { 'AC Switch': '1' } }]);
  bridgeFails = true;
  const r = await tuya.executeTuyaAction('AC', '1', true);
  bridgeFails = false;
  assert.ok(!JSON.stringify(r).includes('xGS9-not-a-real-key'), 'local key redacted');
  assert.match(r.error, /^Tuya bridge set failed: ValueError: invalid literal/);
});

test('a DP saved as a function code gets a clear "scan again" message', async () => {
  const r = await tuya.executeTuyaAction('AC', 'switch_1', true);
  assert.match(r.error, /"switch_1" is a function code, not a DP number: scan again in Settings/);
});

test('the Smart Life scan maps function codes to DP numbers (and keeps read-only DPs)', () => {
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'modules'))})
from tuya_cloud import dp_mapping
class F:
    def __init__(self, code, desc): self.code, self.desc = code, desc
class D: pass
d = D()
d.function = {"switch_1": F("switch_1", "Switch")}
d.status_range = {"cur_power": F("cur_power", "Power"), "mystery": F("mystery", "")}
d.local_strategy = {1: {"status_code": "switch_1"}, 19: {"status_code": "cur_power"}}
print(json.dumps(dp_mapping(d)))
`;
  const out = require('node:child_process').execFileSync('python3', ['-I', '-c', py], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out), { mapping: { 1: 'Switch', 19: 'Power' }, codes: { 1: 'switch_1', 19: 'cur_power' }, unmapped: ['mystery'] });
});

test('selectors send HA the field its service wants, and MQTT the value', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /'select\.select_option': 'option'/);
  assert.match(server, /executeHAAction\(device, action, entity, haServiceData\(action, params\)\)/);
  assert.match(server, /let payload = params\?\.payload !== undefined && params\?\.payload !== null \? params\.payload : params\?\.value;/);
  assert.match(fs.readFileSync(path.join(ROOT, 'public/js/components/stateSelectBlock.js'), 'utf8'), /container\.dataset\.metric = config\.metric \|\| config\.entity/);
});
