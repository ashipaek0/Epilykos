'use strict';
// LuxPower is read through its dongle profiles (Wi-Fi or Bluetooth), never a
// wired Modbus profile: the Modbus poller sends plain Modbus RTU holding-register
// reads, while a LuxPower inverter keeps its readings in input registers and
// expects its serial number inside every RS-485 request. A profile like that
// labelled settings registers as PV, battery and grid values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'lux-modbus-')));
const { loadProfiles, availableProfiles } = require('../modules/modbus');

test('no Modbus profile claims to read a LuxPower inverter', () => {
  loadProfiles();
  assert.ok(availableProfiles.length > 0);
  assert.deepEqual(availableProfiles.filter(p => /lux\s*power/i.test(`${p.id} ${p.name}`)).map(p => p.name), []);
});

test('the in-app Help points LuxPower owners at the dongle profiles only', () => {
  const help = fs.readFileSync(path.join(ROOT, 'public', 'settings.html'), 'utf8');
  assert.doesNotMatch(help, /Luxpower \(Modbus RTU RS-485\)/);
  assert.match(help, /LuxPowerTek Generic Hybrid/);
});
