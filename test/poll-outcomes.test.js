'use strict';
const checks = require('./_checks');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-poll-outcomes-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const config = (key, devices) => database.setConfig(key, JSON.stringify(devices));

// Stub only the I/O boundary; exercise the real pollers, manager and alert wiring.
require('../modules/utils').assertSafeFetchUrl = async url => ({ ok: true, url });
let haMode = 'network', haCalls = 0;
global.fetch = async () => {
  haCalls++;
  if (haMode === 'network') throw new Error('HA unreachable');
  return { ok: haMode === 'ok', status: 503, json: async () => ({ state: '42' }) };
};
const modbusPath = require.resolve('modbus-serial');
require(modbusPath);
require.cache[modbusPath].exports = class {
  async connectTcp(host) { this.host = host; if (host === 'offline') throw new Error('Modbus unreachable'); }
  async setID() {}
  async readHoldingRegisters(address) {
    if (this.host === 'partial' && address === 60) throw new Error('Register read failed');
    return { data: [42] };
  }
  async close() {}
};
const serialPath = require.resolve('serialport');
require(serialPath);
require.cache[serialPath].exports = { SerialPort: class {
  open(callback) { callback(new Error('Serial device unreachable')); }
} };
const childProcess = require('node:child_process');
childProcess.execFile = (file, args, opts, callback) => {
  if (args[3] === 'offline') callback(new Error('Tuya unreachable'), '', '');
  else callback(null, JSON.stringify({ '1': 42 }), '');
};

const ha = require('../modules/ha');
const modbus = require('../modules/modbus');
modbus.availableProfiles.push({ id: 'fixture', registers: [{ address: 1, metric: 'a' }, { address: 60, metric: 'b' }] });
const rs232 = require('../modules/rs232');
rs232.availableProfiles.push({ id: 'fixture', commands: [], protocol: 'query' });
const tuya = require('../modules/tuya');
const { PollingManager } = require('../services/PollingManager');
const { getBreaker, resetAll, FAILURE_THRESHOLD } = require('../modules/circuitBreaker');
const notifications = require('../modules/notifications');
const { onEvent } = require('../modules/notifications/events');
notifications.init();

(async () => {
  try {
    config('ha_devices', [{ name: 'HA', enabled: true, url: 'http://ha.example', token: 'fixture', entities: { watts: 'sensor.watts' } }]);
    const events = [];
    const unsubscribe = onEvent(e => events.push(e.type));
    const manager = new PollingManager([{ id: 'ha', pollFn: ha.pollHomeAssistant }]);
    const ready = [], errors = [];
    manager.on('metrics-ready', ({ sourceId }) => { ready.push(sourceId); notifications.noteSourceResult(sourceId, true); });
    manager.on('device-error', ({ sourceId, error }) => { errors.push(error); notifications.noteSourceResult(sourceId, false, error); });
    for (let i = 0; i < 3; i++) await manager.runCycle();
    assert.strictEqual(haCalls, 3);
    assert.strictEqual(ready.length, 0);
    assert.strictEqual(errors.length, 3);
    assert.deepStrictEqual(events, ['source.offline']);
    haMode = 'ok';
    await manager.runCycle();
    assert.deepStrictEqual(ready, ['ha']);
    assert.deepStrictEqual(events, ['source.offline', 'source.online']);
    haMode = 'http';
    await manager.runCycle();
    assert.match(errors.at(-1).message, /503/);
    config('ha_devices', []);
    await manager.runCycle();
    assert.strictEqual(ready.length, 1, 'no devices must not claim recovery');
    unsubscribe();

    config('modbus_devices', [{ name: 'bad', enabled: true, host: 'offline', profile: 'fixture' }]);
    let outcome = await modbus.pollModbus();
    assert.strictEqual(outcome.errors.length, outcome.attempted);
    assert.match(outcome.error.message, /unreachable/);
    config('modbus_devices', [{ name: 'partial', enabled: true, host: 'partial', profile: 'fixture' }]);
    outcome = await modbus.pollModbus();
    assert.strictEqual(outcome.attempted, 2);
    assert.strictEqual(outcome.errors.length, 1);
    resetAll();
    let partialErrors = 0, partialReady = 0;
    const partial = new PollingManager([{ id: 'modbus', pollFn: modbus.pollModbus }]);
    partial.on('device-error', () => partialErrors++);
    partial.on('metrics-ready', () => partialReady++);
    for (let i = 0; i < FAILURE_THRESHOLD + 1; i++) await partial.runCycle();
    assert.strictEqual(partialErrors, FAILURE_THRESHOLD + 1);
    assert.strictEqual(partialReady, 0);
    assert.strictEqual(getBreaker('modbus').getState(), 'CLOSED', 'healthy reads keep running despite a failed peer');
    config('modbus_devices', [{ name: 'bad', enabled: true, host: 'offline', profile: 'fixture' }]);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await partial.runCycle();
    assert.strictEqual(getBreaker('modbus').getState(), 'OPEN');

    config('rs232_devices', [{ name: 'serial', enabled: true, profile: 'fixture' }]);
    outcome = await rs232.pollRs232();
    assert.strictEqual(outcome.errors.length, 1);
    assert.match(outcome.error.message, /unreachable/);

    const tuyaDevice = id => ({ name: id, dev_id: id, enabled: true, address: 'device.example', local_key: 'fixture', dps: { tuya_watts: '1' } });
    config('tuya_devices', [tuyaDevice('offline')]);
    outcome = await tuya.pollTuyaDevices();
    assert.strictEqual(outcome.errors.length, 1);
    config('tuya_devices', [tuyaDevice('offline'), tuyaDevice('online')]);
    outcome = await tuya.pollTuyaDevices();
    assert.strictEqual(outcome.attempted, 2);
    assert.strictEqual(outcome.errors.length, 1);
    database.flushMetrics();
    assert.strictEqual(database.getDb().prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('tuya_watts').value, 42);
    console.log('ok - real source failures reach offline alerts and partial failures keep healthy reads running');
    checks.done();
  } finally {
    notifications.stop();
    database.getDb().close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
