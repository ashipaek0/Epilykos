'use strict';
const checks = require('./_checks');
// Settings > Sources keeps Bluetooth and wired BMS in one stored list
// (bms_devices, told apart by transport). Each section must show only its own
// kind: given the whole list, every Bluetooth BMS also came back as an empty
// wired one, and saving stored those copies, so they doubled on every save.
// (Checked in a browser too: two Bluetooth BMS, save, reload: still two, none wired.)
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const js = fs.readFileSync(path.join(__dirname, '../public/settings.js'), 'utf8');
assert.match(js, /buildBmsDeviceList\(bmsDevices\.filter\(d => d && d\.transport !== 'wired'\)\)/, 'Bluetooth section: everything not wired (older entries have no transport)');
assert.match(js, /buildBmsWiredDeviceList\(bmsDevices\.filter\(d => d && d\.transport === 'wired'\)\)/, 'wired section: wired only');
assert.doesNotMatch(js, /build(Bms|BmsWired)DeviceList\(JSON\.parse\(data\.bms_devices/, 'neither section is given the whole list');
console.log('ok - each BMS section shows only its own kind');
checks.done();
