'use strict';

/**
 * Inverter and battery settings as a source for the control cards (Controls
 * page only): they are listed by type (switch, list, number), read live and
 * changed through /api/controls/read and /change with the value the card last
 * showed, and never through /api/action or a polled metric.
 *
 * Run: node --test test/device-setting-controls.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-devctl-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
process.env.LOG_TO_FILE = 'false';
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

// ── What is listed ──────────────────────────────────────────────────
test('LuxPower and BMS settings are listed by type, with their ranges and choices', () => {
  const database = require('../modules/database');
  database.initializeDatabase();
  const config = (key, value) => database.setConfig(key, JSON.stringify(value));
  config('dongle_config', [{ name: 'Lux', enabled: true, profile: 'luxpower-geta-3k6-24v', transport: 'luxpower-tcp' }]);
  config('bms_devices', [{ name: 'Pack', enabled: true, address: 'AA:BB:CC:DD:EE:FF', bms_type: 'jbd_bms' }]);
  config('mqtt_devices', [{ name: 'Broker', broker: 'b1', enabled: true, topics: { relay: 'home/relay' } }]);
  const list = require('../modules/switchables').switchableEntities();
  const device = list.filter(s => s.source === 'device');
  assert.ok(device.length > 20, 'the GETA profile has many settings');
  assert.ok(list.some(s => s.source === 'mqtt'), 'the other sources are still listed');

  const lux = name => device.find(s => s.device === 'Lux' && s.entity === name);
  assert.equal(lux('ac_charge_enabled').deviceKind, 'switch');
  assert.equal(lux('output_priority').deviceKind, 'select');
  assert.ok(lux('output_priority').options.length >= 2 && lux('output_priority').options.every(o => typeof o.value === 'string' && o.label));
  assert.equal(lux('charge_power_percent').deviceKind, 'number');
  assert.deepEqual([lux('charge_power_percent').min, lux('charge_power_percent').max, lux('charge_power_percent').step, lux('charge_power_percent').unit], [0, 100, 1, '%']);
  assert.equal(device.find(s => s.entity === 'ac_charge_start_time_1'), undefined, 'times of day have no control card');

  const pack = device.filter(s => s.device === 'Pack');
  assert.deepEqual(pack.map(s => [s.entity, s.deviceKind]).sort(), [['charging', 'switch'], ['discharging', 'switch']]);

  for (const s of device) {
    assert.equal(s.metric, '', 'no polled metric');
    assert.equal(s.action, null); assert.equal(s.selectAction, null); assert.equal(s.setAction, null, 'and no /api/action name');
    assert.match(s.group, /^Inverter and battery · /);
  }
});

test('each card offers only the device settings of its type, and the Button card none', () => {
  const src = read('public/js/editor.js');
  const body = src.match(/function switchableFor\(s, kind\) \{[\s\S]*?\n\}/)[0];
  const box = {}; vm.runInNewContext(body + '\nglobalThis.f = switchableFor;', box);
  const f = (s, kind) => box.f(s, kind);
  const sw = { source: 'device', deviceKind: 'switch' }, sel = { source: 'device', deviceKind: 'select' }, num = { source: 'device', deviceKind: 'number' };
  assert.deepEqual(['toggle', 'select', 'set', 'button'].map(k => f(sw, k)), [true, false, false, false]);
  assert.deepEqual(['toggle', 'select', 'set', 'button'].map(k => f(sel, k)), [false, true, false, false]);
  assert.deepEqual(['toggle', 'select', 'set', 'button'].map(k => f(num, k)), [false, false, true, false]);
  assert.equal(f({ source: 'ha', action: 'switch.toggle' }, 'toggle'), true, 'other sources are unchanged');
  assert.equal(f({ source: 'ha', action: null, selectAction: 'select.select_option' }, 'select'), true);
  assert.equal(f({ source: 'mqtt', action: 'toggle', selectAction: 'set', setAction: 'set' }, 'button'), true);
  assert.match(src, /fillStatesFromDevice\(s\)/); assert.match(src, /fillRangeFromDevice\(s, replaced\)/); assert.match(src, /var replaced = !!before && before !== s\.entity;/, 'a different control gets its own range, not the old one\'s');
  // A device setting has no action name, so the slider and knob form must not ask for one (it refused to save the card, with only a small red line saying why).
  assert.match(src, /if \(!config\.action && config\.source !== 'device'\) return 'Set the action this '/);
  assert.doesNotMatch(src, /if \(!config\.action\) return 'Set the action this '/);
});

// ── Reading and changing ────────────────────────────────────────────
const reply = (data, ok = true) => ({ ok, json: async () => data });
function recorder(answers) {
  const sent = [];
  const doFetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  return { sent, doFetch };
}
const cfg = { source: 'device', device: 'Lux', entity: 'charge_power_percent', min: 0, max: 100, step: 5 };

test('a read goes to /api/controls/read; an error or a setting that cannot be changed is passed on', async () => {
  const { readDeviceSetting } = await load('public/js/components/deviceSetting.js');
  let r = recorder([reply({ value: 40, writable: true })]);
  assert.deepEqual(await readDeviceSetting(cfg, r.doFetch), { value: 40, writable: true, blockedReason: '' });
  assert.deepEqual(r.sent, [{ url: '/api/controls/read', body: { device: 'Lux', setting: 'charge_power_percent' } }]);
  r = recorder([reply({ value: true, writable: false, blockedReason: 'Detected device is not single-phase GETA (type13)' })]);
  assert.deepEqual(await readDeviceSetting(cfg, r.doFetch), { value: true, writable: false, blockedReason: 'Detected device is not single-phase GETA (type13)' });
  r = recorder([reply({ error: 'connection closed' }, false)]);
  assert.deepEqual(await readDeviceSetting(cfg, r.doFetch), { error: 'connection closed' });
  r = recorder([new Error('network down')]);
  assert.deepEqual(await readDeviceSetting(cfg, r.doFetch), { error: 'network down' });
});

test('a change goes to /api/controls/change with the value the card last showed', async () => {
  const { changeDeviceSetting } = await load('public/js/components/deviceSetting.js');
  let r = recorder([reply({ success: true, value: 60, status: 'verified' })]);
  assert.deepEqual(await changeDeviceSetting(cfg, 60, 40, r.doFetch), { value: 60 });
  assert.deepEqual(r.sent, [{ url: '/api/controls/change', body: { device: 'Lux', setting: 'charge_power_percent', value: 60, expected: 40 } }]);
  // The device's read-back is what counts.
  r = recorder([reply({ success: true, value: 55 })]);
  assert.equal((await changeDeviceSetting(cfg, 60, 40, r.doFetch)).value, 55);
  // Refused: the reason, and what it is now when it changed since.
  r = recorder([reply({ success: false, error: 'It changed since you looked; read it again', current: 70 }, false)]);
  await assert.rejects(() => changeDeviceSetting(cfg, 60, 40, r.doFetch), e => e.message.startsWith('It changed since') && e.current === 70);
  r = recorder([reply({ success: false, error: 'Changing device settings is turned off. Turn it on on the Controls page.' }, false)]);
  await assert.rejects(() => changeDeviceSetting(cfg, 60, 40, r.doFetch), /turned off/);
});

test('the setting is read again every minute while the card is on the page, and at once on request', async () => {
  const { watchDeviceSetting } = await load('public/js/components/deviceSetting.js');
  const r = recorder([reply({ value: 1 }), reply({ value: 2 }), reply({ value: 3 })]);
  const results = [];
  let tick = null, cleared = false;
  const container = { isConnected: true };
  const w = watchDeviceSetting(container, cfg, x => results.push(x.value), { doFetch: r.doFetch, setTimer: fn => { tick = fn; return 1; }, clearTimer: () => { cleared = true; } });
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(results, [1], 'read as soon as the card is drawn');
  tick(); await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(results, [1, 2], 'and again on each interval');
  await w.refresh();
  assert.deepEqual(results, [1, 2, 3], 'or when asked');
  container.isConnected = false; tick();
  assert.equal(cleared, true, 'it stops when the card leaves the page');
  assert.equal(r.sent.length, 3);
});

// ── The slider and knob controller ──────────────────────────────────
function harness() {
  const status = { textContent: '' };
  const classes = new Set();
  const container = { dataset: {}, title: '', isConnected: true, classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    removeAttribute() {}, querySelector: sel => (sel === '.numctl-status' ? status : null) };
  const shown = [], busy = [];
  return { container, status, classes, shown, busy, view: { show: v => shown.push(v), busy: b => busy.push(b) } };
}
const later = () => new Promise(res => setTimeout(res, 15));

test('a slider on a device setting shows its live value, sends the change with that value, and shows the read-back', async () => {
  const { createNumericController } = await load('public/js/components/numericControl.js');
  const h = harness();
  const r = recorder([reply({ value: 40, writable: true }), reply({ success: true, value: 60 })]);
  const c = createNumericController(h.container, cfg, h.view, { doFetch: r.doFetch });
  await later();
  assert.deepEqual(h.shown, [40], 'the live value is shown');
  assert.equal(c.settled, 40);
  await c.commitNow(61);
  assert.deepEqual(r.sent[1], { url: '/api/controls/change', body: { device: 'Lux', setting: 'charge_power_percent', value: 60, expected: 40 } }, 'snapped, with the value last shown');
  assert.equal(c.settled, 60);
  assert.ok(!r.sent.some(s => s.url === '/api/action'), 'never through /api/action');
});

test('a change refused because the setting moved shows what it is now, and reads it again', async () => {
  const { createNumericController } = await load('public/js/components/numericControl.js');
  const h = harness();
  const r = recorder([reply({ value: 40, writable: true }), reply({ success: false, error: 'It changed since you looked; read it again', current: 70 }, false), reply({ value: 70, writable: true })]);
  const c = createNumericController(h.container, cfg, h.view, { doFetch: r.doFetch });
  await later();
  await c.commitNow(60);
  await later();
  assert.match(h.status.textContent, /changed since you looked/);
  assert.equal(c.settled, 70);
  assert.equal(h.shown[h.shown.length - 1], 70);
  assert.equal(r.sent[2].url, '/api/controls/read', 'and the card read it again');
});

test('a setting that cannot be changed locks the control and says why; a read error marks the card unavailable', async () => {
  const { createNumericController } = await load('public/js/components/numericControl.js');
  let h = harness();
  createNumericController(h.container, cfg, h.view, { doFetch: recorder([reply({ value: 30, writable: false, blockedReason: 'Detected device is not single-phase GETA (type13)' })]).doFetch });
  await later();
  assert.equal(h.busy[h.busy.length - 1], true, 'locked');
  assert.match(h.container.title, /not single-phase GETA/);
  h = harness();
  createNumericController(h.container, cfg, h.view, { doFetch: recorder([reply({ error: 'timeout' }, false)]).doFetch });
  await later();
  assert.equal(h.classes.has('is-unavailable'), true);
  assert.equal(h.container.title, 'timeout');
});

test('a setting that is off the card\'s step grid is shown and remembered as the device has it, so a change is not refused as "changed since you looked"', async () => {
  const { createNumericController } = await load('public/js/components/numericControl.js');
  const h = harness();
  // The device has 45 A; the card was set up with a step of 10 (0 to 100), so 45 is between two steps.
  const grid = { source: 'device', device: 'Lux', entity: 'ac_charge_battery_current', min: 0, max: 100, step: 10, unit: 'A' };
  const r = recorder([reply({ value: 45, writable: true }), reply({ success: true, value: 60 })]);
  const c = createNumericController(h.container, grid, h.view, { doFetch: r.doFetch });
  await later();
  assert.deepEqual(h.shown, [45], 'shows 45, not the nearest step (50)');
  assert.equal(c.settled, 45, 'and remembers 45');
  await c.commitNow(60);
  assert.deepEqual(r.sent[1].body, { device: 'Lux', setting: 'ac_charge_battery_current', value: 60, expected: 45 }, 'the change carries what the device has, which it matches');
  assert.equal(c.settled, 60);
  // A device above the card's top is not clamped to it either.
  const h2 = harness();
  const r2 = recorder([reply({ value: 120, writable: true }), reply({ success: true, value: 90 })]);
  const c2 = createNumericController(h2.container, grid, h2.view, { doFetch: r2.doFetch });
  await later();
  assert.equal(c2.settled, 120);
  await c2.commitNow(90);
  assert.equal(r2.sent[1].body.expected, 120);
});

test('why a control is locked or cannot be read stays on the card, not only in its tooltip', async () => {
  const { createNumericController } = await load('public/js/components/numericControl.js');
  let h = harness();
  createNumericController(h.container, cfg, h.view, { doFetch: recorder([reply({ value: 30, writable: false, blockedReason: 'Detected device is not single-phase GETA (type13)' })]).doFetch });
  await later();
  assert.match(h.status.textContent, /^Can't be changed: Detected device is not single-phase GETA/);
  h = harness();
  createNumericController(h.container, cfg, h.view, { doFetch: recorder([reply({ error: 'timeout' }, false)]).doFetch });
  await later();
  assert.equal(h.status.textContent, "Can't read this setting: timeout");
});

test('other sources still send through /api/action with no read of their own', async () => {
  const { createNumericController } = await load('public/js/components/numericControl.js');
  const h = harness();
  const r = recorder([reply({ success: true })]);
  const c = createNumericController(h.container, { source: 'ha', device: 'Home', action: 'number.set_value', entity: 'number.x', min: 0, max: 80, step: 5 }, h.view, { doFetch: r.doFetch });
  await c.commitNow(50);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].url, '/api/action');
});

// ── The toggle and the state select ─────────────────────────────────
test('the toggle and the state select read and change a device setting through the same helper', () => {
  const sw = read('public/js/components/switchBlock.js'), ss = read('public/js/components/stateSelectBlock.js');
  for (const src of [sw, ss]) {
    assert.match(src, /import \{ isDeviceSetting, changeDeviceSetting, watchDeviceSetting \} from '\.\/deviceSetting\.js'/);
    assert.match(src, /container\.dataset\.metric = device \? '' : \(config\.metric \|\| config\.entity \|\| ''\)/, 'no polled metric');
    assert.match(src, /changeDeviceSetting\(config, /);
    assert.match(src, /watchDeviceSetting\(container, config, /);
  }
  assert.match(sw, /changeDeviceSetting\(config, this\.checked, deviceValue\)/, 'the toggle sends the value it last showed');
  assert.match(ss, /changeDeviceSetting\(config, deviceNumber\(value\), deviceValue\)/);
  // A list value that looks like a number is sent as one (a device enum is a number).
  const body = ss.match(/function deviceNumber\(value\) \{[\s\S]*?\n\}/)[0];
  const box = {}; vm.runInNewContext(body + '\nglobalThis.f = deviceNumber;', box);
  assert.deepEqual([box.f('2'), box.f(' 3 '), box.f('eco'), box.f('007'), box.f('')], [2, 3, 'eco', '007', '']);
  for (const card of ['sliderCard', 'rotaryCard']) assert.match(read(`public/js/components/${card}.js`), /isDeviceSetting\(config\) \? '' :/);
});

test('control cards stay on the Controls page: elsewhere they are still a placeholder', () => {
  const index = read('public/js/components/index.js');
  for (const type of ['switch-block', 'state-select', 'slider-card', 'rotary-card']) assert.match(index, new RegExp(`'${type}': buildControlPlaceholder`));
});
