'use strict';
const checks = require('./_checks');
// A stuck BlueZ (every device refused with org.bluez.Error.InProgress, or no
// adapter) for two minutes, with nothing working since, makes the app ask
// EpilykosOS to restart it (bluetooth_recover), at most once per 10 minutes.
// Other errors neither count nor clear it; a request that works does.
const assert = require('node:assert/strict');
const path = require('path');
const { createMonitor, stuckReason, STUCK_MS, COOLDOWN_MS } = require(path.join(__dirname, '../modules/bleRecovery'));

const IN_PROGRESS = Object.assign(new Error('BleakDBusError: [org.bluez.Error.InProgress] Operation already in progress'), { code: 'ble_error' });
const NO_ADAPTER = Object.assign(new Error('No Bluetooth adapter found on the host.'), { code: 'no_adapter' });
const TIMEOUT = Object.assign(new Error('Bluetooth operation timed out'), { code: 'timeout' });
const A = { address: '58:2B:0A:50:9F:83' }, B = { address: '58:2b:0a:50:89:d7' };

function setup(reply = { ok: true, restarted: true }, available = true) {
  let t = 1e9;
  const calls = [], logs = [];
  const m = createMonitor({ now: () => t, available: () => available, call: async (a, p) => { calls.push([a, p]); return typeof reply === 'function' ? reply() : reply; },
    log: { info: s => logs.push(['info', s]), warn: s => logs.push(['warn', s]) } });
  return { m, calls, logs, tick: ms => { t += ms; }, now: () => t };
}
const settle = () => new Promise(r => setImmediate(r));

(async () => {
  assert.equal(stuckReason(IN_PROGRESS), 'in_progress');
  assert.equal(stuckReason(NO_ADAPTER), 'no_adapter');
  assert.equal(stuckReason(TIMEOUT), null);
  assert.equal(stuckReason(null), null);
  console.log('ok - InProgress and no adapter mean BlueZ is stuck; timeouts don\'t');

  // Both inverters refused for two minutes -> one restart, then a 10 minute pause.
  let s = setup();
  s.m.record('gatt_read', A, IN_PROGRESS); s.m.record('gatt_read', B, IN_PROGRESS);
  s.tick(STUCK_MS - 1000); s.m.record('gatt_read', A, IN_PROGRESS);
  assert.equal(s.calls.length, 0, 'not before two minutes');
  s.tick(2000); await s.m.record('gatt_read', B, IN_PROGRESS); await settle();
  assert.deepEqual(s.calls, [['bluetooth_recover', { reason: 'in_progress' }]]);
  assert.ok(s.logs.some(([l, m]) => l === 'warn' && /asked EpilykosOS to restart BlueZ/.test(m)));
  s.tick(STUCK_MS + 1000); s.m.record('gatt_read', A, IN_PROGRESS); s.m.record('gatt_read', B, IN_PROGRESS);
  s.tick(STUCK_MS + 1000); s.m.record('gatt_read', A, IN_PROGRESS); await s.m.record('gatt_read', B, IN_PROGRESS);
  assert.equal(s.calls.length, 1, 'at most once per 10 minutes');
  s.tick(COOLDOWN_MS); await s.m.record('gatt_read', A, IN_PROGRESS); await s.m.record('gatt_read', B, IN_PROGRESS); await settle();
  assert.equal(s.calls.length, 2, 'again after 10 minutes if still stuck');
  console.log('ok - every device refused for two minutes: BlueZ restarted, at most once per 10 minutes');

  // One device working: not stuck.
  s = setup();
  s.m.record('gatt_read', A, IN_PROGRESS); s.m.record('read_bms', B, null);
  s.tick(STUCK_MS + 1000); s.m.record('gatt_read', A, IN_PROGRESS); await settle();
  assert.equal(s.calls.length, 0);
  // A device just out of range (timeouts) with the other refused: not every device is stuck.
  s = setup();
  s.m.record('gatt_read', A, IN_PROGRESS); s.m.record('gatt_read', B, TIMEOUT);
  s.tick(STUCK_MS + 1000); s.m.record('gatt_read', A, IN_PROGRESS); s.m.record('gatt_read', B, TIMEOUT); await settle();
  assert.equal(s.calls.length, 0);
  // A success clears a device's stuck state.
  s = setup();
  s.m.record('gatt_read', A, IN_PROGRESS); s.tick(STUCK_MS); s.m.record('gatt_read', A, null);
  s.tick(1000); s.m.record('gatt_read', A, IN_PROGRESS); await settle();
  assert.equal(s.calls.length, 0, 'counting starts again after a success');
  // Status and settings commands don't count.
  s = setup();
  s.m.record('status', {}, NO_ADAPTER); s.tick(STUCK_MS + 1000); s.m.record('set_max_links', {}, NO_ADAPTER); await settle();
  assert.equal(s.calls.length, 0);
  console.log('ok - not while any device works, a device is only out of range, or after a success; status calls ignored');

  // No adapter at start (lost reply while it powered up): reason no_adapter; scans count too.
  s = setup();
  s.m.record('gatt_read', A, NO_ADAPTER); s.m.record('scan', {}, IN_PROGRESS);
  s.tick(STUCK_MS + 1); await s.m.record('gatt_read', A, NO_ADAPTER); await settle();
  assert.deepEqual(s.calls, [['bluetooth_recover', { reason: 'no_adapter' }]]);
  console.log('ok - no adapter for two minutes: asked with reason no_adapter');

  // The host restarted it recently: wait as long as it says.
  s = setup({ ok: true, restarted: false, retry_in: 300 });
  s.m.record('gatt_read', A, IN_PROGRESS); s.tick(STUCK_MS + 1); await s.m.record('gatt_read', A, IN_PROGRESS); await settle();
  assert.equal(s.calls.length, 1);
  assert.ok(s.m._state().nextAllowed >= s.now() + 299000);
  s.tick(301000); await s.m.record('gatt_read', A, IN_PROGRESS); await settle();
  assert.equal(s.calls.length, 2);
  // Refused or unreachable host: logged, tried again after the pause.
  s = setup(() => { throw new Error('connect ENOENT /run/epilykos-host/host.sock'); });
  s.m.record('gatt_read', A, IN_PROGRESS); s.tick(STUCK_MS + 1); await s.m.record('gatt_read', A, IN_PROGRESS); await settle();
  assert.ok(s.logs.some(([l, m]) => l === 'warn' && /could not ask EpilykosOS/.test(m)));
  // Not EpilykosOS: say what to do, once per pause.
  s = setup(undefined, false);
  s.m.record('gatt_read', A, IN_PROGRESS); s.tick(STUCK_MS + 1); s.m.record('gatt_read', A, IN_PROGRESS); s.tick(1000); s.m.record('gatt_read', A, IN_PROGRESS);
  assert.equal(s.calls.length, 0);
  assert.equal(s.logs.filter(([, m]) => /systemctl restart bluetooth/.test(m)).length, 1);
  console.log('ok - host says wait: waits; host unreachable or not EpilykosOS: logged, no loop');

  // modules/ble.js reports every request's outcome.
  const { BleHelper } = require(path.join(__dirname, '../modules/ble'));
  const seen = [];
  const h = new BleHelper({ command: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-ble-helper.js')], isConfigured: () => true,
    linkCount: () => 1, onOutcome: (cmd, args, err) => seen.push([cmd, args.n || null, err ? err.code : null]) });
  await h.request('echo', { n: 1 });
  await h.request('fail', { code: 'no_adapter' }).catch(() => {});
  await settle();
  await h.stop();
  assert.deepEqual(seen, [['echo', 1, null], ['fail', null, 'no_adapter']]);
  const src = require('fs').readFileSync(path.join(__dirname, '../modules/ble.js'), 'utf8');
  assert.match(src, /new BleHelper\(\{ onOutcome: \(cmd, args, err\) => recovery\.record\(cmd, args, err\) \}\)/);
  console.log('ok - the Bluetooth helper reports each request\'s outcome to the monitor');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
