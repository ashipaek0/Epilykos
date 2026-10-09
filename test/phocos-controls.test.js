'use strict';
const checks = require('./_checks');
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phocos-controls-'));
process.chdir(tmp);
const database = require('../modules/database');
database.initializeDatabase();
const dongle = require('../modules/dongle');
const controls = require('../modules/deviceControls');
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '../profiles/dongles/phocos-anygrid-ble.json')));
const settings = controls.settingsOf(profile);
let current = { record_fault_codes: false, output_priority: 0, max_charging_current: 20 };
let modelSupported = true, calls = [];
database.setConfig('dongle_config', JSON.stringify([{ name: 'Pho', enabled: true, profile: 'phocos-anygrid-ble', transport: 'ble-gatt' }]));
dongle.getProfileById = () => profile;
dongle.phocosSettings = async () => ({ values: Object.fromEntries(Object.entries(current).map(([id, value]) => [id, { value }])), raw: { settings_2a0c: '01' }, model: { supported: modelSupported, nominalVoltage: 48, acVoltage: 120 }, capabilities: profile.settings.map(s => ({ ...s, min: s.id === 'max_charging_current' ? 0 : s.min, max: s.id === 'max_charging_current' ? 80 : s.max, allowed: s.id === 'output_voltage' ? [110, 120, 127] : s.allowed, writable: modelSupported && s.writable === true, blockedReason: modelSupported ? (s.reason || null) : 'Unknown or unsupported model/rating combination' })) });
dongle.changePhocosSetting = async (device, id, expected, value) => { calls.push({ device, id, expected, value }); const status = global.nextStatus || 'done'; if (status === 'done') current[id] = value; return { ok: status === 'done', status, written: ['sent_unverified', 'mismatch'].includes(status), readback: status === 'done' ? (typeof value === 'boolean' || typeof value === 'number' ? value : { value }) : status === 'mismatch' ? false : undefined, reason: status === 'mismatch' ? 'Mismatch observed' : status === 'sent_unverified' ? 'Readback unavailable' : undefined }; };
const req = { ip: 'test' };
(async () => {
  assert.equal(settings.find(s => s.name === 'record_fault_codes').type, 'switch');
  assert.equal(settings.find(s => s.name === 'output_priority').type, 'select');
  assert.equal(settings.find(s => s.name === 'max_charging_current').type, 'number');
  assert.ok(settings.every(s => s.writable === false));
  assert.ok(controls.listDevices()[0].note.includes('read the device'));
  assert.equal((await controls.readSetting('Pho', 'record_fault_codes')).value, false);
  assert.equal((await controls.readSetting('Pho', 'record_fault_codes')).writable, true);
  controls.setSwitches({ enabled: false });
  assert.match((await controls.changeSetting({ device: 'Pho', setting: 'record_fault_codes', expected: false, value: true }, req)).error, /turned off/);
  assert.equal(calls.length, 0);
  controls.setSwitches({ enabled: true });
  modelSupported = false;
  assert.match((await controls.changeSetting({ device: 'Pho', setting: 'record_fault_codes', expected: false, value: true }, req)).error, /Unknown or unsupported/);
  modelSupported = true;
  assert.match((await controls.changeSetting({ device: 'Pho', setting: 'record_fault_codes', value: true }, req)).error, /expected/);
  assert.match((await controls.changeSetting({ device: 'Pho', setting: 'record_fault_codes', expected: true, value: false }, req)).error, /changed since/);
  assert.equal(calls.length, 0);
  assert.equal((await controls.changeSetting({ device: 'Pho', setting: 'record_fault_codes', expected: false, value: false }, req)).status, 'noop');
  assert.equal((await controls.changeSetting({ device: 'Pho', setting: 'output_priority', expected: 0, value: 1 }, req)).success, true);
  assert.equal((await controls.changeSetting({ device: 'Pho', setting: 'max_charging_current', expected: 20, value: 21 }, req)).success, true);
  for (const status of ['mismatch', 'sent_unverified']) {
    global.nextStatus = status;
    const r = await controls.changeSetting({ device: 'Pho', setting: 'record_fault_codes', expected: false, value: true }, req);
    assert.equal(r.status, status);
    if (status === 'sent_unverified') { assert.equal(r.written, true); assert.equal(r.value, undefined); assert.match(r.error, /Readback unavailable/); }
    if (status === 'mismatch') { assert.equal(r.written, true); assert.equal(r.value, false); assert.equal(r.error, 'Mismatch observed'); }
    assert.equal(controls.recentLog(1)[0].outcome, status === 'sent_unverified' ? 'unverified' : 'failed');
  }
  global.nextStatus = null;
  assert.equal(calls.filter(c => c.id === 'record_fault_codes').length, 2);
  console.log('phocos controls: focused checks passed');
  checks.done(1);
})().catch(e => { console.error(e); process.exit(1); });
