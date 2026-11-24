'use strict';
const checks = require('./_checks');
/**
 * performAction (modules/deviceActions.js): the dispatch behind POST
 * /api/action, tested without a server and with the transports faked:
 * - refusals (missing fields, switch off, no device, unknown source) are
 *   logged and nothing is sent;
 * - each source passes the right arguments to its transport;
 * - a transport error is a 502, a thrown one a 500, both logged;
 * - the "Allow device changes" switch can be bypassed only by a log source
 *   that starts with "automation:", and the log keeps that source.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-actions-'));
process.chdir(tmp);
process.env.SETTINGS_PASSWORD = 'made-up-test-password';
const database = require('../modules/database');
database.initializeDatabase();
const controls = require('../modules/deviceControls');
const { performAction, adapters, haServiceData, resolveActionDevice } = require('../modules/deviceActions');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }
const lastLog = () => controls.recentLog(1)[0];

(async () => {
  const calls = [];
  const rec = name => async (...a) => { calls.push([name, ...a]); return { success: true }; };
  for (const k of ['ha', 'mqtt', 'tuya', 'modbus', 'rs232', 'dongle']) adapters[k] = rec(k);
  adapters.recordMetric = (...a) => calls.push(['recordMetric', ...a]);
  database.setConfig('tuya_devices', JSON.stringify([{ name: 'Geyser', dev_id: 'abc', enabled: true, dps: { relay: 1 } }, { name: 'Off', enabled: false, dps: { relay: 1 } }]));
  database.setConfig('mqtt_devices', JSON.stringify([{ name: 'Pump', broker: 'mqtt://b', enabled: true, topics: { pump: 'cmnd/pump/POWER' } }]));
  database.setConfig('ha_devices', JSON.stringify([{ name: 'Home', enabled: true, entities: { fan: { entityId: 'fan.lounge' } } }]));

  await check('refusals are logged and nothing is sent', async () => {
    controls.setSwitches({ enabled: true });
    let r = await performAction({ source: 'tuya' });
    assert.strictEqual(r.status, 400); assert.strictEqual(lastLog().outcome, 'refused');
    r = await performAction({ source: 'tuya', action: 'turn_on', entity: 'nothing' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /device is required/);
    r = await performAction({ source: 'bogus', action: 'x', device: 'D', entity: 'e' });
    assert.strictEqual(r.status, 501);
    controls.setSwitches({ enabled: false });
    r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'relay' });
    assert.strictEqual(r.status, 403); assert.match(r.body.error, /turned off/);
    assert.strictEqual(lastLog().source, 'action:tuya'); assert.strictEqual(lastLog().outcome, 'refused');
    assert.strictEqual(calls.length, 0);
  });

  controls.setSwitches({ enabled: true });

  await check('Tuya: finds the DP, sends true by default, records the value', async () => {
    calls.length = 0;
    let r = await performAction({ source: 'tuya', action: 'turn_on', entity: 'relay' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls[0], ['tuya', 'Geyser', 1, true]);
    assert.strictEqual(calls[1][0], 'recordMetric'); assert.strictEqual(calls[1][2], true);
    assert.strictEqual(lastLog().outcome, 'done');
    calls.length = 0;
    r = await performAction({ source: 'tuya', action: 'set', device: 'Geyser', entity: 'relay', params: { value: false } });
    assert.deepStrictEqual(calls[0], ['tuya', 'Geyser', 1, false]);
    r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Off', entity: 'relay' });
    assert.strictEqual(r.status, 502); assert.match(r.body.error, /not found or disabled/);
    r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'missing' });
    assert.match(r.body.error, /DP not found/);
  });

  await check('MQTT: payload from params, or ON/OFF from the action', async () => {
    calls.length = 0;
    await performAction({ source: 'mqtt', action: 'turn_on', entity: 'cmnd/pump/POWER' });
    await performAction({ source: 'mqtt', action: 'turn_off', device: 'Pump', entity: 'cmnd/pump/POWER' });
    await performAction({ source: 'mqtt', action: 'set', device: 'Pump', entity: 'cmnd/pump/POWER', params: { payload: 'X' } });
    await performAction({ source: 'mqtt', action: 'set', device: 'Pump', entity: 'cmnd/pump/POWER', params: { value: 7 } });
    assert.deepStrictEqual(calls.map(c => c[3]), ['ON', 'OFF', 'X', 7]);
    assert.ok(calls.every(c => c[1] === 'mqtt://b'), 'a device name becomes its broker');
  });

  await check('Home Assistant: selectors get the field their service wants', async () => {
    calls.length = 0;
    await performAction({ source: 'ha', action: 'select.select_option', entity: 'select.mode', device: 'Home', params: { value: 'eco' } });
    assert.deepStrictEqual(calls[0], ['ha', 'Home', 'select.select_option', 'select.mode', { option: 'eco' }]);
    assert.strictEqual(resolveActionDevice('ha', '', 'fan.lounge'), 'Home');
    assert.deepStrictEqual(haServiceData({ domain: 'climate', service: 'set_hvac_mode' }, { value: 'heat' }), { hvac_mode: 'heat' });
  });

  await check('Modbus, RS232 and dongle registers pass their arguments', async () => {
    calls.length = 0;
    await performAction({ source: 'modbus', action: 'write', device: 'M', entity: '40001', params: { value: 5, type: 'coil' } });
    await performAction({ source: 'rs232', action: 'cmd', device: 'R', entity: 'x', params: { value: 2 } });
    await performAction({ source: 'dongle', action: 'write', device: 'Nope', entity: 'holding:0x0069', params: { value: 3 } });
    assert.deepStrictEqual(calls, [['modbus', 'M', '40001', 5, 'coil'], ['rs232', 'R', 'cmd', 2], ['dongle', 'Nope', '0x0069', 3]]);
  });

  await check('errors: a transport error is 502, a throw is 500, both logged', async () => {
    adapters.tuya = async () => ({ success: false, error: 'offline' });
    let r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'relay' });
    assert.strictEqual(r.status, 502); assert.strictEqual(r.body.error, 'offline'); assert.strictEqual(lastLog().outcome, 'failed');
    adapters.tuya = async () => { throw new Error('boom'); };
    r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'relay' });
    assert.strictEqual(r.status, 500); assert.strictEqual(r.body.error, 'Action failed'); assert.strictEqual(lastLog().detail, 'boom');
    adapters.tuya = rec('tuya');
  });

  await check('only automation log sources may bypass the switch', async () => {
    controls.setSwitches({ enabled: false });
    calls.length = 0;
    let r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'relay' }, { bypassSwitch: true });
    assert.strictEqual(r.status, 403, 'bypass without an automation source is ignored');
    r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'relay' }, { logSource: 'controls', bypassSwitch: true });
    assert.strictEqual(r.status, 403);
    r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'relay' }, { logSource: 'automation:7', bypassSwitch: true });
    assert.strictEqual(r.status, 200); assert.strictEqual(lastLog().source, 'automation:7');
    r = await performAction({ source: 'tuya', action: 'turn_on', device: 'Geyser', entity: 'relay' }, { logSource: 'automation:7' });
    assert.strictEqual(r.status, 403, 'an automation must ask for the bypass');
    assert.ok(!controls.mayBypassSwitch({ bypassSwitch: true, source: 'controls' }));
    const bypassed = await controls.changeSetting({ device: 'Nope', setting: 'x', value: 1 }, null, { source: 'automation:1', bypassSwitch: true });
    assert.strictEqual(bypassed.error, 'Device not found or turned off', 'the switch is skipped: it got as far as looking up the device');
    assert.ok(!/Changing device settings is turned off/.test(bypassed.error));
    assert.strictEqual((await controls.changeSetting({ device: 'Nope', setting: 'x', value: 1 }, null, { source: 'automation:1' })).error, 'Changing device settings is turned off. Turn it on on the Controls page.');
  });

  checks.done(passed);
})().catch(e => { console.error(e); process.exit(1); });
