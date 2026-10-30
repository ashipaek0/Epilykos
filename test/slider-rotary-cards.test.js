'use strict';

/**
 * Slider and rotary knob cards (Controls page): the range and snapping they
 * share, how a change is sent (once, on release), how a reading is held back
 * while a change is on its way, the knob's geometry, the numbers a card can
 * target, and its wiring into the Controls layout, editor and showcase.
 *
 * Isolation: scratch cwd (DB_PATH is cwd-relative) and ENC_KEY_FILE.
 * Run: node --test test/slider-rotary-cards.test.js
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-numctl-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
process.env.LOG_TO_FILE = 'false';
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

// ── Range, snapping, reading ────────────────────────────────────────
test('the range is always usable: min below max, a step above zero', async () => {
  const { rangeOf } = await load('public/js/components/numericControl.js');
  assert.deepEqual(rangeOf({ min: 0, max: 80, step: 5 }), { min: 0, max: 80, step: 5, decimals: 0 });
  assert.deepEqual(rangeOf({ min: '10', max: '90', step: '0.5' }), { min: 10, max: 90, step: 0.5, decimals: 1 });
  assert.equal(rangeOf({ min: 0, max: 1, step: 0.05 }).decimals, 2, 'decimals follow the step');
  assert.equal(rangeOf({ min: 0, max: 1, step: 0.1, decimals: 3 }).decimals, 3, 'unless the card says otherwise');
  assert.deepEqual(rangeOf({}), { min: 0, max: 100, step: 1, decimals: 0 }, 'nothing set: 0 to 100');
  const flipped = rangeOf({ min: 50, max: 10, step: -3 });
  assert.ok(flipped.max > flipped.min && flipped.step > 0, 'a max at or below the min, or a step below zero, is repaired');
  assert.equal(rangeOf({ min: 0, max: 10, step: 50 }).step, 10, 'a step larger than the range is the range');
  assert.equal(rangeOf({ min: '', max: '', step: '' }).max, 100, 'empty fields are not zero');
});

test('a value snaps to the step grid and stays inside the range', async () => {
  const { rangeOf, snap, fractionOf } = await load('public/js/components/numericControl.js');
  const a = rangeOf({ min: 0, max: 80, step: 10 });
  assert.equal(snap(34, a), 30); assert.equal(snap(35, a), 40); assert.equal(snap(-5, a), 0); assert.equal(snap(500, a), 80);
  assert.equal(snap('42', a), 40, 'text from an input');
  for (const bad of ['', null, undefined, 'abc', NaN, Infinity]) assert.equal(snap(bad, a), null, String(bad));
  const b = rangeOf({ min: 0, max: 1, step: 0.1 });
  assert.equal(snap(0.3, b), 0.3, 'no 0.30000000000000004');
  assert.equal(snap(0.7000000001, b), 0.7);
  const c = rangeOf({ min: 10, max: 95, step: 20 });
  assert.equal(snap(95, c), 90, 'the last step that fits, never past the max');
  assert.equal(snap(10, c), 10);
  const d = rangeOf({ min: 20, max: 30, step: 0.25 });
  assert.equal(snap(24.9, d), 25); assert.equal(snap(24.8, d), 24.75);
  assert.equal(fractionOf(40, a), 0.5); assert.equal(fractionOf(-10, a), 0); assert.equal(fractionOf(999, a), 1);
});

test('values read as the unit names them', async () => {
  const { rangeOf, formatValue, decimalsOf } = await load('public/js/components/numericControl.js');
  const r = rangeOf({ min: 0, max: 100, step: 0.5 });
  assert.equal(formatValue(42, r, 'A'), '42.0 A'); assert.equal(formatValue(42, r, '%'), '42.0%'); assert.equal(formatValue(21.5, r, '°C'), '21.5°C');
  assert.equal(formatValue(3, rangeOf({}), ''), '3'); assert.equal(formatValue(null, r, 'A'), '—'); assert.equal(formatValue('x', r, 'A'), '—');
  assert.deepEqual([decimalsOf(1), decimalsOf(0.5), decimalsOf(0.05), decimalsOf(1e-3)], [0, 1, 2, 3]);
});

// ── Sending and holding a change ────────────────────────────────────
function harness(overrides = {}) {
  const status = { textContent: '' };
  const classes = new Set();
  const container = { dataset: {}, title: '', classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    querySelector: sel => (sel === '.numctl-status' ? status : null) };
  const shown = [], busy = [];
  const view = { show: v => shown.push(v), busy: b => busy.push(b) };
  const sent = [];
  let reply = { ok: true, json: async () => ({ success: true }) };
  const doFetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), headers: init.headers }); if (reply instanceof Error) throw reply; return reply; };
  let clock = 1_000_000;
  return { container, status, classes, view, shown, busy, sent, doFetch, now: () => clock, tick: ms => { clock += ms; }, setReply: r => { reply = r; },
    config: { source: 'ha', device: 'Home', action: 'number.set_value', entity: 'number.charge_current', min: 0, max: 80, step: 5, ...overrides } };
}
async function controller(h) {
  const { createNumericController } = await load('public/js/components/numericControl.js');
  return createNumericController(h.container, h.config, h.view, { doFetch: h.doFetch, now: h.now });
}

test('moving the control sends nothing; letting go sends the value once, as the other control cards do', async () => {
  const h = harness(), c = await controller(h);
  assert.equal(c.preview(33), 35, 'shown snapped');
  assert.equal(c.preview(52), 50);
  assert.deepEqual(h.sent, [], 'a drag sends nothing');
  assert.equal(h.container.dataset.dragging, '1');
  await c.commitNow(50);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].url, '/api/action');
  assert.deepEqual(h.sent[0].body, { source: 'ha', device: 'Home', action: 'number.set_value', entity: 'number.charge_current', params: { value: 50 } });
  assert.equal(h.sent[0].headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(h.container.dataset.dragging, undefined);
  assert.deepEqual(h.busy, [true, false], 'locked while the change is on its way');
  await c.commitNow(50);
  assert.equal(h.sent.length, 1, 'the same value is not sent again');
});

test('keys settle before they send: one change for a run of presses', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness(), c = await controller(h);
    c.commitSoon(5); c.commitSoon(10); c.commitSoon(15);
    assert.equal(h.sent.length, 0);
    assert.deepEqual(h.shown, [5, 10, 15], 'each press shows at once');
    mock.timers.tick(349); assert.equal(h.sent.length, 0);
    mock.timers.tick(1);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(h.sent.map(x => x.body.params.value), [15]);
  } finally { mock.timers.reset(); }
});

test('a refused or failed change goes back to the last known value and says why', async () => {
  const h = harness(), c = await controller(h);
  c.reading(30, 'ha', { value: 30 });
  assert.equal(c.settled, 30);
  h.setReply({ ok: false, status: 423, json: async () => ({ error: 'Writes are locked. Unlock on the Controls page.' }) });
  await c.commitNow(60);
  assert.equal(h.shown[h.shown.length - 1], 30, 'back to what it was');
  assert.match(h.status.textContent, /^Error: Writes are locked/);
  assert.ok(h.classes.has('is-error'));
  assert.equal(c.settled, 30);
  h.setReply({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  await c.commitNow(60);
  assert.match(h.status.textContent, /HTTP 502/, 'a reply with no JSON still says what failed');
  h.setReply(new Error('network down'));
  await c.commitNow(60);
  assert.match(h.status.textContent, /network down/);
  assert.equal(h.container.dataset.busy, undefined, 'unlocked again after a failure');
  assert.equal(h.busy[h.busy.length - 1], false);
});

test('a reading older than the change is held back, then believed', async () => {
  const h = harness(), c = await controller(h);
  c.reading(30, 'ha', { value: 30 });
  await c.commitNow(60);
  assert.equal(h.container.dataset.pending, '60');
  const before = h.shown.length;
  c.reading(30, 'ha', { value: 30 });
  assert.equal(h.shown.length, before, 'the old reading does not undo the change on screen');
  c.reading(60, 'ha', { value: 60 });
  assert.equal(h.container.dataset.pending, undefined, 'a reading that agrees ends the hold');
  assert.equal(c.settled, 60);
  await c.commitNow(40);
  h.tick(46_000);
  c.reading(55, 'ha', { value: 55 });
  assert.equal(c.settled, 55, 'after 45 s the device wins, so a change it ignored does not stay on screen');
});

test('readings are ignored while the control is being moved, and a silent device shows as unavailable', async () => {
  const h = harness(), c = await controller(h);
  c.preview(40);
  const n = h.shown.length;
  c.reading(10, 'ha', { value: 10 });
  assert.equal(h.shown.length, n, 'a drag is not fought by a reading');
  await c.commitNow(40);
  h.container.dataset.pending = ''; delete h.container.dataset.pending;
  const old = Date.now() - 10 * 60 * 1000;
  c.reading(25, 'tuya', { value: 25, timestamp: old });
  assert.ok(h.classes.has('is-unavailable'), 'a Tuya reading minutes old: the device is not answering');
  assert.equal(h.container.title, 'The device is not answering');
  assert.notEqual(c.settled, 25);
  c.reading(25, 'tuya', { value: 25, timestamp: Date.now() });
  assert.equal(h.classes.has('is-unavailable'), false);
  assert.equal(c.settled, 25);
  for (const bad of ['abc', null, '']) { const before = c.settled; c.reading(bad, 'ha', {}); assert.equal(c.settled, before, String(bad)); }
});

test('the updater gives each card the reading of its own metric', async () => {
  const { createNumericController, updateNumericControls } = await load('public/js/components/numericControl.js');
  const make = (metric, source = 'ha') => { const h = harness(); h.container.dataset.metric = metric; h.container.dataset.source = source; createNumericController(h.container, h.config, h.view, { doFetch: h.doFetch, now: h.now }); return h; };
  const a = make('number.charge_current'), b = make('number.other'), none = { container: { dataset: { metric: 'x' } } };
  globalThis.document = { querySelectorAll: () => [a.container, b.container, none.container] };
  try {
    updateNumericControls({ metrics: { 'number.charge_current': { value: 35 }, 'number.other': { value: null } } }, '.numctl-slider');
    assert.deepEqual(a.shown, [35]); assert.deepEqual(b.shown, [], 'no value: left alone');
    updateNumericControls(undefined, '.numctl-slider'); updateNumericControls({}, '.numctl-slider');
  } finally { delete globalThis.document; }
});

// ── The knob ────────────────────────────────────────────────────────
test('the knob turns through 270° from the bottom left to the bottom right, relative to where it is grabbed', async () => {
  const { arcPath, angleDelta, pointerAngle, START_DEG, SWEEP_DEG } = await load('public/js/components/rotaryCard.js');
  assert.deepEqual([START_DEG, SWEEP_DEG], [135, 270]);
  assert.equal(arcPath(0), '', 'nothing to draw at the minimum');
  assert.equal(arcPath(-1), '');
  const full = arcPath(1);
  assert.match(full, /^M\d+\.\d+ \d+\.\d+A46 46 0 1 1 \d+\.\d+ \d+\.\d+$/, 'over 180°: the large arc');
  assert.match(arcPath(0.2), /A46 46 0 0 1 /, 'under 180°: the small arc');
  const [, x0, y0] = full.match(/^M([\d.]+) ([\d.]+)/), [, x1, y1] = full.match(/ ([\d.]+) ([\d.]+)$/);
  assert.ok(Math.abs(x0 - 27.47) < 0.01 && Math.abs(y0 - 92.53) < 0.01, 'starts bottom left');
  assert.ok(Math.abs(x1 - 92.53) < 0.01 && Math.abs(y1 - 92.53) < 0.01, 'ends bottom right');
  const half = arcPath(0.5).match(/ ([\d.]+) ([\d.]+)$/);
  assert.ok(Math.abs(half[1] - 60) < 0.01 && Math.abs(half[2] - 14) < 0.01, 'halfway is straight up');
  // Turning across the ±180° seam is a small turn, not a full one.
  assert.equal(angleDelta(170, -170), 20); assert.equal(angleDelta(-170, 170), -20);
  assert.equal(angleDelta(10, 40), 30); assert.equal(angleDelta(40, 10), -30); assert.equal(angleDelta(0, 0), 0);
  assert.ok(Math.abs(pointerAngle(1, 0)) < 1e-9); assert.equal(pointerAngle(0, 1), 90); assert.equal(pointerAngle(-1, 0), 180); assert.equal(pointerAngle(0, -1), -90);
});

// ── Cards without a target, and the accent ──────────────────────────
test('a card with nothing to control says so; the accent must be a hex colour', async () => {
  const { accentOf } = await load('public/js/components/sliderCard.js');
  for (const [given, want] of [['#f59e0b', '#f59e0b'], ['#FFF', '#FFF'], [' #123456 ', '#123456'], ['red', ''], ['url(x)', ''], ['#xyz', ''], ['', ''], [undefined, '']]) assert.equal(accentOf({ color: given }), want, String(given));
  assert.equal(accentOf(null), '');
  const slider = read('public/js/components/sliderCard.js'), rotary = read('public/js/components/rotaryCard.js');
  assert.match(slider, /Choose what this slider controls in the layout editor/);
  assert.match(rotary, /Choose what this knob controls in the layout editor/);
  assert.match(slider, /type="range"[^>]*aria-label/, 'a native range input with a name');
  assert.match(rotary, /role="slider" tabindex="0"[^>]*aria-valuemin[^>]*aria-valuemax/, 'the knob is a slider to a screen reader');
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) assert.match(rotary, new RegExp(`'${key}'`), key);
  assert.match(rotary, /setPointerCapture/); assert.doesNotMatch(rotary, /'wheel'/, 'scrolling the page never turns a control');
});

// ── What a card can target ──────────────────────────────────────────
test('Home Assistant numbers, Tuya values and MQTT topics can be set; nothing else is offered', async () => {
  const database = require('../modules/database');
  database.initializeDatabase();
  const config = (key, value) => database.setConfig(key, JSON.stringify(value));
  config('ha_devices', [{ name: 'Home', enabled: true, entities: { charge_a: 'number.charge_current', cutoff: { entityId: 'input_number.cutoff' }, relay: 'switch.relay', mode: 'select.mode', light: 'light.lamp', temp: 'sensor.temp' } }]);
  config('tuya_devices', [{ name: 'Heater', enabled: true, dps: { target_temp: 4 } }]);
  config('mqtt_devices', [{ name: 'Broker', broker: 'b1', enabled: true, topics: { limit: 'inverter/limit' } }]);
  const { switchableEntities, HA_SET } = require('../modules/switchables');
  assert.deepEqual(HA_SET, { number: 'number.set_value', input_number: 'input_number.set_value' });
  const list = switchableEntities();
  const settable = list.filter(s => s.setAction).map(s => [s.source, s.entity, s.setAction]);
  assert.deepEqual(settable, [['tuya', 'target_temp', 'set'], ['ha', 'number.charge_current', 'number.set_value'], ['ha', 'input_number.cutoff', 'input_number.set_value'], ['mqtt', 'inverter/limit', 'set']]);
  assert.equal(list.find(s => s.entity === 'switch.relay').setAction, null, 'a switch is not a number');
  assert.equal(list.find(s => s.entity === 'light.lamp').setAction, null, 'a light stays a switch: its brightness is an attribute the card could not show back');
  assert.equal(list.find(s => s.entity === 'light.lamp').action, 'light.toggle', 'and is still offered to toggle cards');
  assert.equal(list.find(s => s.entity === 'select.mode').setAction, null);
  assert.equal(list.find(s => s.entity === 'sensor.temp'), undefined);
  const ha = require('../modules/ha');
  assert.deepEqual(ha.getActionsForEntity('number.charge_current'), ['set_value']);
  assert.deepEqual(ha.getActionsForEntity('input_number.cutoff'), ['set_value']);
  // A number's value goes to Home Assistant as `value`, which is the field number.set_value takes.
  assert.match(read('server.js'), /const HA_VALUE_FIELD = \{[^}]*\};/);
  assert.doesNotMatch(read('server.js').match(/const HA_VALUE_FIELD = \{[^}]*\}/)[0], /number\.set_value/, 'no renaming: params.value is already the field');
});

test('a Home Assistant number tells the editor its own range and unit', () => {
  const src = read('modules/ha.js');
  assert.match(src, /e\.entity_id\.startsWith\('number\.'\)/); assert.match(src, /e\.entity_id\.startsWith\('input_number\.'\)/);
  assert.match(src, /min: null, max: null, step: null, unit: null/, 'the empty answer has the new keys');
  assert.match(src, /unit: typeof attrs\.unit_of_measurement === 'string'/);
});

// ── Wiring ──────────────────────────────────────────────────────────
test('both cards are on the Controls page, in the editor, and in the showcase; elsewhere they are a placeholder', () => {
  const index = read('public/js/components/index.js');
  assert.match(index, /'slider-card': buildControlPlaceholder/); assert.match(index, /'rotary-card': buildControlPlaceholder/);
  assert.match(index, /'slider-card': buildSliderCard/); assert.match(index, /'rotary-card': buildRotaryCard/);
  assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('slider-card'\)\) updateSliderCardsFromState/);
  assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('rotary-card'\)\) updateRotaryCardsFromState/);
  assert.match(read('public/js/components/controlPlaceholder.js'), /'slider-card': 'Slider', 'rotary-card': 'Rotary knob'/);
  const catalog = read('public/js/editor-catalog.js');
  assert.match(catalog, /'slider-card':\s+\{ group: 'controls', name: 'Slider'/); assert.match(catalog, /'rotary-card':\s+\{ group: 'controls', name: 'Rotary knob'/);
  assert.match(catalog, /\n  slider: '<path/); assert.match(catalog, /\n  rotary: '<circle/);
  assert.match(read('modules/dashboard-config.js'), /CONTROL_TYPES = new Set\(\[[^\]]*'slider-card', 'rotary-card'\]\)/);
  const editor = read('public/js/editor.js');
  assert.match(editor, /case 'slider-card':\s+case 'rotary-card':\s+html \+= buildNumericControlForm\(block\)/);
  assert.match(editor, /case 'slider-card':\s+case 'rotary-card':\s+bindSwitchPicker\('set', 'modal-num'\)/);
  assert.match(editor, /Set the lowest and highest value/); assert.match(editor, /The highest value must be above the lowest/); assert.match(editor, /The step must be a number above zero/);
  assert.match(editor, /kind === 'set' \? s\.setAction/);
  assert.match(read('private/js/showcase-layout.js'), /type: 'slider-card'/); assert.match(read('private/js/showcase-layout.js'), /type: 'rotary-card'/);
  assert.match(read('private/js/showcase-data.js'), /'number\.charge_current': '30'/);
  const css = read('public/cards.css');
  for (const cls of ['.numctl-range', '.numctl-knob', '.knob-fill', '.numctl.is-unavailable', '.numctl.is-error']) assert.ok(css.includes(cls), cls);
});

test('the Controls layout accepts both cards, with their settings kept', () => {
  const { saveControlsLayout, getControlsLayout } = require('../modules/dashboard-config');
  saveControlsLayout([
    { id: 's1', type: 'slider-card', gridX: 0, gridY: 0, gridW: 4, gridH: 3, config: { entity: 'number.charge_current', source: 'ha', device: 'Home', action: 'number.set_value', min: 0, max: 80, step: 5, unit: 'A' } },
    { id: 'r1', type: 'rotary-card', gridX: 4, gridY: 0, gridW: 3, gridH: 5, config: { entity: 'number.cutoff', source: 'ha', device: 'Home', action: 'number.set_value', min: 10, max: 90, step: 5, unit: '%' } }
  ]);
  const saved = getControlsLayout();
  assert.deepEqual(saved.map(b => b.type), ['slider-card', 'rotary-card']);
  assert.equal(saved[0].config.max, 80); assert.equal(saved[1].config.unit, '%');
  assert.throws(() => saveControlsLayout([{ id: 'x', type: 'gauge-card' }]), /slider and knob cards/);
});
