'use strict';
const checks = require('./_checks');
/**
 * Battery banks, with made-up values:
 * - a bank of wired batteries is computed even though no Bluetooth battery is set up
 *   (the BMS poller used to return before the bank step), and so is a bank when
 *   Bluetooth itself is unavailable;
 * - a bank with no metrics still reports how many batteries answer;
 * - a battery that has not reported yet offers the usual readings, so a bank can be
 *   set up first, and only with ?fallback=1;
 * - the settings page lists wired batteries in a bank, keeps a battery that was renamed
 *   visible, keeps a chosen reading that is not reported right now, and says so when a
 *   bank would have no metrics.
 */
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-bank-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.BMS_BRIDGE_URL;

const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const bms = require('../modules/bms');
const agg = require('../modules/bmsAggregator');
const now = () => Math.floor(Date.now() / 1000);
const put = (metric, value) => db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run(metric, value, now());
const bankMetrics = () => { database.flushMetrics(); return Object.fromEntries(db.prepare("SELECT metric, value FROM latest_metrics WHERE metric LIKE 'bank_%'").all().map(r => [r.metric, r.value])); };

(async () => {
  // Two wired batteries, no Bluetooth battery at all.
  database.setConfig('bms_devices', JSON.stringify([
    { name: 'Wired A', enabled: true, transport: 'wired', serial_path: '/dev/ttyUSB0', profile: 'x', mappings: {} },
    { name: 'Wired B', enabled: true, transport: 'wired', serial_path: '/dev/ttyUSB0', profile: 'x', mappings: {} }]));
  database.setConfig('bms_banks', JSON.stringify([{ name: 'Wired Bank', enabled: true, devices: [{ name: 'Wired A' }, { name: 'Wired B' }],
    functions: [{ output: 'wb_voltage', fn: 'mean', sources: { 'Wired A': 'voltage', 'Wired B': 'voltage' } }] }]));
  put('bms_Wired_A_voltage', 52.0); put('bms_Wired_B_voltage', 52.4);
  await bms.pollBMS();
  let m = bankMetrics();
  assert.equal(m.bank_wb_voltage, 52.2, 'a bank of wired batteries is computed by the BMS poll');
  assert.equal(m.bank_Wired_Bank_devices_online, 2);
  console.log('ok - a bank of wired batteries is computed with no Bluetooth battery set up');

  // Bluetooth batteries configured but Bluetooth unavailable: the bank still uses what is there.
  database.setConfig('bms_devices', JSON.stringify([
    { name: 'Wired A', enabled: true, transport: 'wired', serial_path: '/dev/ttyUSB0', profile: 'x', mappings: {} },
    { name: 'Wired B', enabled: true, transport: 'wired', serial_path: '/dev/ttyUSB0', profile: 'x', mappings: {} },
    { name: 'Ble C', enabled: true, address: 'AA:BB:CC:DD:EE:03', mappings: {} }]));
  db.prepare("DELETE FROM latest_metrics WHERE metric LIKE 'bank_%'").run();
  put('bms_Wired_A_voltage', 51.0); put('bms_Wired_B_voltage', 51.4);
  await bms.pollBMS();    // no D-Bus socket in the test environment
  assert.equal(bankMetrics().bank_wb_voltage, 51.2, 'the bank is computed even when Bluetooth is unavailable');
  console.log('ok - a bank is computed when Bluetooth is unavailable');

  // A bank with no metrics reports how many batteries answer.
  db.prepare("DELETE FROM latest_metrics WHERE metric LIKE 'bank_%'").run();
  await agg.computeBankAggregates({ name: 'Empty', enabled: true, devices: [{ name: 'Wired A' }, { name: 'Wired B' }], functions: [] }, 30);
  m = bankMetrics();
  assert.equal(m.bank_Empty_devices_online, 2, 'devices online is published without any bank metric');
  assert.ok(m.bank_Empty_last_update > 0);
  await agg.computeBankAggregates({ name: 'Off', enabled: false, devices: [{ name: 'Wired A' }], functions: [] }, 30);
  assert.equal(bankMetrics().bank_Off_devices_online, undefined, 'a switched-off bank publishes nothing');
  console.log('ok - a bank with no metrics still reports devices online');

  // Source keys: the usual ones before the first reading, only when asked.
  assert.deepEqual(agg.getAvailableSourceKeys('Never Seen'), []);
  const fb = agg.getAvailableSourceKeys('Never Seen', { fallback: true });
  assert.ok(fb.length === agg.COMMON_BMS_KEYS.length && fb.every(x => x.value === null) && fb.some(x => x.key === 'battery_level'));
  assert.ok(agg.getAvailableSourceKeys('Wired A', { fallback: true }).some(x => x.key === 'voltage' && x.value === 51), 'real readings win over the usual list');
  assert.equal(agg.getAvailableSourceKeys('Wired A', { fallback: true }).length, 1);
  console.log('ok - a battery with no readings yet offers the usual keys when asked');

  // The settings page.
  const js = fs.readFileSync(path.join(REPO, 'public/settings.js'), 'utf8');
  const srv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.match(srv, /getAvailableSourceKeys\(name, \{ fallback: req\.query\.fallback === '1' \}\)/);
  const pop = js.slice(js.indexOf('function populateBankDevices('), js.indexOf('function renderBankFunctionRow('));
  assert.match(pop, /#bms-devices-container \.device-card/); assert.match(pop, /#bms-wired-devices-container \.device-card/, 'wired batteries can be in a bank');
  assert.match(pop, /missing/, 'a renamed or removed battery stays listed'); assert.match(pop, /was renamed or removed/);
  assert.match(js, /device-metrics\/\$\{encodeURIComponent\(deviceName\)\}\?fallback=1/);
  assert.match(js, /if \(selectedKey && !keys\.includes\(selectedKey\)\) keys\.unshift\(selectedKey\)/, 'a chosen reading is kept in its list');
  assert.match(js, /function refreshBankDeviceLists\(\)/); assert.match(js, /new MutationObserver\(later\)\.observe\(el, \{ childList: true \}\)/, 'the bank lists follow batteries being added, removed or drawn late (wired cards appear after a port lookup)');
  assert.match(js, /list\.id\.replace\('bank-devices-', ''\)/, 'the refresh uses the id the card was built with');
  assert.match(js, /bank-empty-hint/); assert.match(js, /function updateBankHint\(card\)/);
  assert.match(js, /card\.addEventListener\('change', \(\) => updateBankHint\(card\)\)/);
  console.log('ok - settings: wired batteries in a bank, renamed batteries visible, chosen readings kept, empty-bank hint');

  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
