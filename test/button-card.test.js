'use strict';

/**
 * Button card (Home Assistant style): state reading, state text, the action
 * each tap sends per source, icon rendering, and its wiring into the
 * Controls page, editor, showcase and the HA entity list.
 *
 * Run: node --test test/button-card.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => src.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

const box = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), emptyBlock: () => null };
vm.runInNewContext(`${strip(read('public/js/components/buttonIcons.js'))}\n${strip(read('public/js/components/buttonCard.js'))}
globalThis.api = { stateOf, stateLabel, actionRequest, iconHtml, MDI_ICONS, DEFAULT_ON_COLOR, DEFAULT_OFF_COLOR };`, box);
const { stateOf, stateLabel, iconHtml, MDI_ICONS } = box.api;
// Objects made in the vm realm have its prototypes: compare plain copies.
const actionRequest = (...a) => JSON.parse(JSON.stringify(box.api.actionRequest(...a)));

test('state: on/off/unknown from any source value', () => {
  for (const v of ['on', 'true', 'TRUE', 1, true, '1', 'cool', 'heat', 'playing']) assert.equal(stateOf(v), 'on', String(v));
  for (const v of ['off', 'false', 0, false, '0', 'idle', 'closed', 'standby']) assert.equal(stateOf(v), 'off', String(v));
  for (const v of ['unavailable', 'unknown', null, undefined]) assert.equal(stateOf(v), 'unknown', String(v));
});

test('state text: On/Off, richer states as they are, custom words', () => {
  assert.equal(stateLabel('true'), 'On');
  assert.equal(stateLabel('off'), 'Off');
  assert.equal(stateLabel('heat_cool'), 'Heat cool');
  assert.equal(stateLabel('unavailable'), 'Unavailable');
  assert.equal(stateLabel('on', { onText: 'Running' }), 'Running');
  assert.equal(stateLabel('off', { offText: 'Stopped' }), 'Stopped');
});

test('tap actions per source', () => {
  const tuya = { source: 'tuya', device: 'Fridge', entity: 'Fridge Switch' };
  assert.deepEqual(actionRequest(tuya, false), { source: 'tuya', device: 'Fridge', entity: 'Fridge Switch', action: 'set', params: { value: true } });
  assert.deepEqual(actionRequest(tuya, true).params, { value: false }, 'toggle sends the opposite of what is shown');
  assert.deepEqual(actionRequest({ ...tuya, tapAction: 'on' }, true).params, { value: true });
  const ha = { source: 'ha', device: 'Home', entity: 'switch.cooker' };
  assert.equal(actionRequest(ha, true).action, 'switch.turn_off');
  assert.equal(actionRequest(ha, false).action, 'switch.turn_on');
  assert.equal(actionRequest({ ...ha, entity: 'button.lux_buzzer' }, false).action, 'button.press');
  assert.equal(actionRequest({ ...ha, entity: 'scene.movie' }, false).action, 'scene.turn_on');
  assert.equal(actionRequest({ ...ha, tapAction: 'press', entity: 'input_button.bell' }, false).action, 'input_button.press');
  assert.equal(actionRequest({ source: 'mqtt', device: 'mqtt://b', entity: 'plug/set' }, false).action, 'turn_on');
  assert.deepEqual(actionRequest({ source: 'mqtt', device: 'mqtt://b', entity: 'bell/set', tapAction: 'press' }, false).params, { payload: 'PRESS' });
  assert.equal(actionRequest({ ...ha, tapAction: 'none' }, false), null);
});

test('icons: mdi names, images, emoji; text is escaped', () => {
  assert.ok(Object.keys(MDI_ICONS).length > 100);
  for (const n of ['air-conditioner', 'fan', 'stove', 'desktop-tower-monitor', 'bell', 'lightbulb', 'fridge']) assert.ok(MDI_ICONS[n], n);
  assert.match(iconHtml('mdi:fan'), /^<svg viewBox="0 0 24 24"[^>]*><path fill="currentColor" d="M/);
  assert.match(iconHtml('/uploads/ac.png'), /^<img src="\/uploads\/ac.png"/);
  assert.match(iconHtml('🔔'), /bc-emoji">🔔</);
  assert.ok(!/<script/.test(iconHtml('<script>x</script>')));
});

test('wired into Controls, the editor, showcase and HA entities', () => {
  const index = read('public/js/components/index.js');
  assert.match(index, /'button-card': buildButtonCard/);
  assert.match(index, /'button-card': buildControlPlaceholder/);
  assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('button-card'\)\) updateButtonCardsFromState/);
  assert.match(read('public/js/editor-catalog.js'), /'button-card':\s+\{ group: 'controls'/);
  const editor = read('public/js/editor.js');
  assert.match(editor, /case 'button-card':\s+html \+= buildButtonCardForm\(block\)/);
  assert.match(editor, /BLOCK_BUILDERS\.set\('button-card'/);
  assert.match(read('private/js/showcase-layout.js'), /type: 'button-card'/);
  assert.match(read('modules/dashboard-config.js'), /CONTROL_TYPES = new Set\(\[[^\]]*'button-card'/, 'the Controls layout keeps button cards');
  const ha = require('../modules/ha');
  assert.deepEqual(ha.getActionsForEntity('button.lux_buzzer'), ['press']);
});
