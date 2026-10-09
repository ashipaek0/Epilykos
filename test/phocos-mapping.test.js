'use strict';
const checks = require('./_checks');
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/', 'phocos-mapping-'));
process.chdir(tmp);
const database = require('../modules/database');
database.initializeDatabase();
const queued = [];
database.queueMetricValue = (metric, value, timestamp, unit) => queued.push({ metric, value, unit });
const settingsCalls = [];
const gattModulePath = require.resolve('../modules/dongle/bleGatt');
require.cache[gattModulePath] = {
  id: gattModulePath, filename: gattModulePath, loaded: true,
  exports: { BleGattTransport: class {
    constructor(instance, actualProfile) { this.instance = instance; this.profile = actualProfile; }
    async settings() { settingsCalls.push(this.profile); return { values: {}, model: { supported: false } }; }
    async changeSetting() { throw new Error('unknown model writes must not run'); }
  } }
};
const dongle = require('../modules/dongle');
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '../profiles/dongles/phocos-anygrid-ble.json')));
(async () => {
  const field = profile.fields.find(f => f.name === 'operating_mode');
  assert.equal(field.type, 'string');
  assert.equal(field.confidence, 'app_confirmed');
  assert.deepEqual(profile.capabilities, { read: true, write: true });
  database.setConfig('dongle_config', JSON.stringify([{ name: 'PhoSettings', enabled: true, profile: 'phocos-anygrid-ble', transport: 'ble-gatt' }]));
  database.setConfig('device_writes_enabled', 'true');
  database.setConfig('device_writes_expert', 'true');
  const settings = await dongle.phocosSettings('PhoSettings');
  assert.deepEqual(settings, { values: {}, model: { supported: false } });
  assert.equal(settingsCalls.length, 1);
  assert.strictEqual(settingsCalls[0], dongle.getProfileById('phocos-anygrid-ble'));
  assert.equal(settingsCalls[0].capabilities.write, true);
  const refusedRawWrite = await dongle.executeDongleAction('PhoSettings', 1, 1);
  assert.match(refusedRawWrite.error, /Bluetooth profile is read-only/);
  assert.ok(!await dongle.changePhocosSetting('PhoSettings', 'output_voltage', 120, 230).then(r => r.ok));
  const transport = { poll: async () => ({ operating_mode: 'B', live: [0,0,0,0,0,0,0,0,0,'12'], status: [], pv1: [], pv2: [], derived: {} }) };
  await dongle.pollJsonInstance({ name: 'Pho', prefix: 'pho_' }, transport, profile);
  assert.ok(!queued.some(x => x.metric === 'pho_operating_mode'));
  assert.ok(queued.some(x => x.metric === 'pho_battery_charging_current' && x.value === 12));
  queued.length = 0;
  await dongle.pollJsonInstance({ name: 'Pho', mappings: { mode: 'operating_mode', amps: 'live[9]' } }, transport, profile);
  assert.ok(queued.some(x => x.metric === 'mode' && x.value === 'B'));
  assert.ok(queued.some(x => x.metric === 'amps' && x.value === 12));
  const numeric = { fields: [{ name: 'n', path: 'n', scale: -2 }] };
  await dongle.pollJsonInstance({ name: 'legacy', prefix: '' }, { poll: async () => ({ n: '3' }) }, numeric);
  assert.ok(queued.some(x => x.metric === 'n' && x.value === -6));
  console.log('phocos mapping: focused checks passed');
  checks.done(1);
})().catch(e => { console.error(e); process.exit(1); });
