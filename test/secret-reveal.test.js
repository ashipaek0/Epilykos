'use strict';
/**
 * test/secret-reveal.test.js — masked fields and displays (public/js/secret-reveal.js).
 *
 * Every password box, and the fields that identify the site or the equipment
 * (location, serial numbers, device IDs, MQTT user), show dots with an eye to
 * look at them; sign-in links, addresses and QR codes sit behind a Show button.
 * The browser behaviour is checked in a real browser; here: which fields are
 * picked, that no page is missing the script, and that the pages mark what
 * they must.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// The script loads without a page: no body yet, so it only waits for one.
const sandbox = { window: {}, document: { body: null, addEventListener() {} } };
vm.createContext(sandbox);
vm.runInContext(read('public/js/secret-reveal.js'), sandbox);
const { SENSITIVE_FIELD } = sandbox.window.secretReveal;
assert.equal(Object.prototype.toString.call(SENSITIVE_FIELD), '[object RegExp]');   // made in the vm, so not instanceof

const masked = [
  'solar_latitude', 'solar_longitude', 'solar-latitude', 'optional.forecast.latitude', 'optional.forecast.longitude',
  'dongle_config[0][serial_number]', 'dongle_config[3][dongle_serial]', 'dongle_config[1][inverter_serial]',
  'sources.dongle.serial_number', 'sources.dongle.dongle_serial', 'sources.dongle.inverter_serial',
  'dongle_config[0][ble_address]', 'sources.dongle.ble_address', 'bms_devices[2][address]', 'sources.bms.address', 'sources.bmsWired.address',
  'tuya_devices[0][dev_id]', 'tuya-uid', 'tuya_devices[0][local_key]',
  'mqtt_devices[0][username]', 'sources.mqtt.username'
];
for (const name of masked) assert.ok(SENSITIVE_FIELD.test(name), `${name} is masked`);

const open = [
  'dongle_config[0][ble_write_uuid]', 'dongle_config[0][ble_notify_uuid]',      // GATT UUIDs, the same on every unit
  'modbus_devices[0][serial_path]', 'modbus_devices[0][serial_baud]', 'rs232_devices[0][serial_path]', 'bms_devices[0][serial_path]',
  'sources.bmsWired.serial_path', 'bms_devices[0][baud]',                       // serial port settings
  'tuya_devices[0][address]', 'modbus_devices[0][host]', 'mqtt_devices[0][broker]', 'ha_devices[0][url]',   // where the unit is on the LAN
  'tuya_devices[0][name]', 'dongle_config[0][name]', 'solar_capacity', 'solar-tilt'
];
for (const name of open) assert.ok(!SENSITIVE_FIELD.test(name), `${name} stays readable`);
console.log('ok - the sensitive fields are picked, and serial-port, LAN and UUID fields are not');

// Every page that has a password box loads the script, and loads it after nothing it needs.
for (const page of ['public/login.html', 'public/settings.html', 'public/setup.html', 'private/pages/controls.html']) {
  assert.match(read(page), /<script[^>]*src="\/?js\/secret-reveal\.js"/, `${page} loads secret-reveal.js`);
}
console.log('ok - the login, settings, setup and controls pages load the script');

// Fields the pages draw themselves.
const settingsJs = read('public/settings.js');
assert.doesNotMatch(settingsJs, /type="text" name="tuya_devices\[\$\{idx\}\]\[local_key\]"/, 'the Tuya local key is not a plain text box');
assert.match(settingsJs, /type="password"[^>]*name="tuya_devices\[\$\{idx\}\]\[local_key\]"/);

// Displays: each address and QR code, and the two-factor key and recovery codes, is marked.
const remote = read('public/js/remote-settings.js');
assert.equal((remote.match(/class="rm-pair" data-sensitive-display="[a-z-]+" data-sensitive-label="[^"]+"/g) || []).length, 3, 'Tailscale sign-in and address, Cloudflare address');
assert.equal((remote.match(/class="rm-pair"(?! data-sensitive)/g) || []).length, 0, 'no address or code is drawn unmasked');
const twoStep = read('public/js/two-step-settings.js');
assert.match(twoStep, /'data-sensitive-display': 'two-step-setup'/);
assert.match(twoStep, /'data-sensitive-display': 'two-step-codes'/);
console.log('ok - the pages mark their addresses, QR codes, authenticator key and recovery codes');

// The styles that hide a display and keep the eye clean inside restyled cards.
const css = read('public/style.css');
assert.match(css, /\.sr-masked\s*\{[^}]*filter:\s*blur/);
assert.match(css, /\.sr-masked\s*\{[^}]*user-select:\s*none/);
assert.match(css, /\.sr-wrap > \.sr-btn\s*\{[^}]*border:\s*0 !important/);
console.log('ok - the hidden display is blurred and unselectable');

// What went wrong once, kept from happening again.
const script = read('public/js/secret-reveal.js');
// A number box empties itself when it holds something that is not a clean number (6,5244 or 6.5244°),
// so a masked number field comes back as text, never as a number.
assert.match(script, /input\.type === 'number' \? 'text'/);
assert.doesNotMatch(script, /shownType = input\.type;/);
// A page hides a field by hiding the input itself; the wrapper and eye follow it, and so does the page's own label rule.
assert.match(script, /attributeFilter: \['style', 'class', 'hidden'\]/);
assert.match(script, /wrap\.style\.display = window\.getComputedStyle\(input\)\.display === 'none' \? 'none' : ''/);
const shell = read('public/settings-shell.css');
assert.match(shell, /\.st-autolabel:has\(> \.sr-wrap > input\[style\*="display: none"\]\)/);
assert.match(read('public/settings.html'), /settings-shell\.css\?v=8/);
// CodeQL: no selector built from an id (backslashes), no markup built from the page's label text.
assert.doesNotMatch(script, /label\[for=/);
assert.doesNotMatch(script, /innerHTML\s*=[^;]*\bwhat\b/);
assert.match(script, /caption\.textContent = \(shown \? 'Hide ' : 'Show '\) \+ what/);
console.log('ok - number fields keep what was typed, and a hidden field takes its eye and label with it');

checks.done();
