'use strict';
const checks = require('./_checks');
// Two Bluetooth inverters each keep a link open: the helper is started with
// one link per enabled Bluetooth inverter or BMS (1 to 3), a running helper
// is told when Settings change them, and Bluetooth inverters start polling
// a few seconds apart.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-ble-links-')));
delete process.env.BLE_MAX_LINKS;
const { initializeDatabase, setConfig } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const { BleHelper, bleLinkCount } = require(path.join(REPO, 'modules/ble'));

(async () => {
  assert.equal(bleLinkCount(), 1, 'nothing configured: one link');
  const inv = (name, transport, enabled = true) => ({ name, transport, enabled, profile: 'phocos-anygrid-ble' });
  setConfig('dongle_config', JSON.stringify([inv('Inverter 1', 'ble-gatt'), inv('Inverter 2', 'ble-gatt'),
    inv('Off', 'ble-gatt', false), inv('Lan', 'solarman-v5')]));
  assert.equal(bleLinkCount(), 2, 'two enabled Bluetooth inverters');
  setConfig('bms_devices', JSON.stringify([{ name: 'B1', enabled: true, address: 'AA:BB:CC:DD:EE:01' },
    { name: 'W', enabled: true, address: '/dev/ttyUSB0', transport: 'wired' }, { name: 'B2', enabled: true, address: 'AA:BB:CC:DD:EE:02' }]));
  assert.equal(bleLinkCount(), 3, 'Bluetooth BMS count, wired ones do not; at most 3');
  console.log('ok - one link per enabled Bluetooth inverter or BMS, 1 to 3');

  const FAKE = path.join(__dirname, 'fixtures', 'fake-ble-helper.js');
  const make = () => new BleHelper({ command: process.execPath, args: [FAKE], isConfigured: () => true, linkCount: () => 2 });
  let h = make();
  assert.equal((await h.request('env', { name: 'BLE_MAX_LINKS' })).value, '2');
  await h.stop();
  process.env.BLE_MAX_LINKS = '1';
  h = make();
  assert.equal((await h.request('env', { name: 'BLE_MAX_LINKS' })).value, '1', 'set by hand: kept');
  await h.stop();
  delete process.env.BLE_MAX_LINKS;
  console.log('ok - the helper starts with that many links; BLE_MAX_LINKS set by hand wins');

  const helper = fs.readFileSync(path.join(REPO, 'modules/ble/ble_helper.py'), 'utf8');
  assert.match(helper, /"set_max_links": cmd_set_max_links,/);
  assert.match(fs.readFileSync(path.join(REPO, 'server.js'), 'utf8'),
    /if \(has\('bms_devices'\) \|\| has\('dongle_config'\)\) require\('\.\/modules\/ble'\)\.updateMaxLinks\(\);/);
  console.log('ok - saving Bluetooth inverters or BMS updates a running helper');

  const dongle = fs.readFileSync(path.join(REPO, 'modules/dongle.js'), 'utf8');
  assert.match(dongle, /startPolls\(poll, intervalMs, bleUnits\+\+ \* BLE_STAGGER_MS\);/);
  assert.match(dongle, /startPolls\(poll, intervalMs, inst\.transport === 'ble-modbus' \? bleUnits\+\+ \* BLE_STAGGER_MS : 0\);/);
  assert.match(dongle, /if \(delayMs > 0\) pollIntervals\.push\(setTimeout\(begin, delayMs\)\);/, 'stopping clears a start not yet made');
  console.log('ok - Bluetooth inverters start polling apart');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
