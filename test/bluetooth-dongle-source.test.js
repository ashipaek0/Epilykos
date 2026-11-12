'use strict';
const checks = require('./_checks');
// Settings > Sources: a Bluetooth dongle is its own source type beside the WiFi dongle (it used to be a "Connection"
// dropdown inside the WiFi dongle card, which people did not find). Both types read and write the same saved dongle
// list; each card belongs to one by its connection, so nothing saved needs to change.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const shell = read('public/js/settings-shell.js'), js = read('public/settings.js'), html = read('public/settings.html'), css = read('public/settings-shell.css');

// The two types: one list of cards, told apart by a card's saved connection.
assert.match(shell, /key: 'dongle', panel: 'dongle', container: 'dongle-devices-container', add: 'add-dongle-device', label: 'WiFi dongle', icon: 'dongle', group: 'Inverter'[^}]*match: function \(card\) \{ return !isBluetoothDongle\(card\); \}/);
assert.match(shell, /key: 'dongle-ble', panel: 'dongle', container: 'dongle-devices-container', add: 'add-dongle-ble-device', label: 'Bluetooth dongle', icon: 'bluetooth', group: 'Inverter'[^}]*match: isBluetoothDongle/);
assert.ok(shell.indexOf("key: 'dongle-ble'") > shell.indexOf("key: 'dongle',") && shell.indexOf("key: 'dongle-ble'") < shell.indexOf("key: 'rs232'"), 'listed with the other inverter types, after the WiFi dongle');
assert.match(shell, /function isBluetoothDongle\(card\) \{\s*\n\s*var tx = card\.querySelector\('select\[name\$="\[transport\]"\]'\);\s*\n\s*return !!tx && \/\^ble-\/\.test\(tx\.value\);/, 'by the card\'s own transport, which is already saved');
assert.match(shell, /return t\.match \? cards\.filter\(t\.match\) : cards;/, 'a type lists only its own cards, so the numbers in #sources/<type>/<n> count them');
assert.match(shell, /function renderSourcesList\(\) \{\s*\n\s*var list = \$\('sources-list'\);\s*\n\s*if \(!list\) return;\s*\n\s*applyTypeFilter\(\);/, 'the list and the panel are filtered together');
assert.match(shell, /classList\.toggle\('is-other-type', !!\(t && t\.match\) && !t\.match\(el\)\)/);
assert.match(css, /\.st-type-panel \.device-card\.is-other-type,/, 'the other type\'s cards are not shown');
assert.match(shell, /bluetooth: '<path d=/, 'it has its own icon');
// The panel's heading and add button follow the type.
assert.match(html, /<h2 id="dongle-head-title">WiFi dongle<\/h2>/);
assert.match(html, /id="add-dongle-device"[^>]*>\+ Add WiFi dongle<\/button>/);
assert.match(html, /id="add-dongle-ble-device"[^>]*>\+ Add Bluetooth dongle<\/button>/);
assert.match(shell, /btn\.style\.display = t && t\.key === k \? '' : 'none'/);

// The card: the type decides the connection, so there is no Connection dropdown to find (the code behind it stays).
assert.match(js, /<label class="dongle-field" style="display:none;"><span class="dongle-field-label">Connection<\/span>\s*\n\s*<select class="dongle-link-select">/);
assert.match(js, /addDongleBleBtn\.addEventListener\('click'[\s\S]*?transport: 'ble-modbus', profile: '', prefix: '', enabled: true, _newCard: true \}, idx\)/, 'a new Bluetooth dongle starts on Bluetooth');
assert.match(js, /transport: 'solarman-v5', profile: '', prefix: '', enabled: true, _newCard: true \}, idx\);\s*\n\}\);/, 'and a WiFi dongle on the network, as before');

// The profile list of a card: a Bluetooth dongle offers what works over Bluetooth, a WiFi dongle the rest; no group.
const grab = name => { const m = js.match(new RegExp(`(?:async )?function ${name}\\(`)); assert.ok(m, name); let i = m.index, depth = 0, started = false; for (let j = js.indexOf('{', i); j < js.length; j++) { if (js[j] === '{') { depth++; started = true; } else if (js[j] === '}' && --depth === 0 && started) return js.slice(i, j + 1); } };
const profiles = [
  { id: 'deye', name: 'Deye', transport: 'solarman-v5' },
  { id: 'growatt', name: 'Growatt', transport: 'growatt' },
  { id: 'felicity', name: 'Felicity', protocol: 'felicity-tcp' },
  { id: 'lux', name: 'LuxPower', protocol: 'luxpower-tcp', transport: 'luxpower-tcp' },
  { id: 'phocos', name: 'Phocos', protocol: 'ble-gatt', transport: 'ble-gatt', connection: 'bluetooth' }
];
const fill = link => {
  const options = [];
  const profileSelect = { innerHTML: '', value: '', appendChild(o) { options.push(o); }, _reset() { options.length = 0; } };
  Object.defineProperty(profileSelect, 'innerHTML', { set() { options.length = 0; }, get() { return ''; } });
  const card = { querySelector: s => (s === '.dongle-profile-select' ? profileSelect : s === '.dongle-link-select' ? { value: link } : null) };
  const ctx = { dongleProfilesCache: profiles, document: { createElement: () => ({}) } };
  vm.createContext(ctx);
  vm.runInContext(['isDongleRegisterProfile', 'isLuxpowerDongleProfile', 'isBleGattProfile', 'isBluetoothOnlyProfile', 'fillDongleProfileOptions'].map(grab).join('\n'), ctx);
  ctx.fillDongleProfileOptions(card, 'phocos');
  return { names: options.map(o => o.value), chosen: profileSelect.value };
};
assert.deepStrictEqual(fill('network').names, ['deye', 'growatt', 'felicity', 'lux'], 'a WiFi dongle does not offer Bluetooth-only profiles, in a group or otherwise');
assert.strictEqual(fill('network').chosen, '', 'and clears one it cannot have');
assert.deepStrictEqual(fill('bluetooth').names, ['deye', 'lux', 'phocos'], 'a Bluetooth dongle offers register profiles, LuxPower and the Bluetooth-only ones, not Growatt or Felicity');
assert.ok(!/optgroup/.test(grab('fillDongleProfileOptions')), 'no "Bluetooth only" group any more');
console.log('ok - Bluetooth dongles are their own source type, with their own profile list');
checks.done();
