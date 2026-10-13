'use strict';

/**
 * In-page colour picker (public/js/editor-color.js): the browser's own
 * <input type="color"> popup ran past the settings panel and off the screen.
 * Checks the colour maths, that the popover is clamped inside the window,
 * and that the editor and Settings use it (Settings counting its edits).
 *
 * Run: node --test test/editor-color-picker.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const src = read('public/js/editor-color.js').replace(/^export /gm, '');

test('hex ↔ HSV round trips', () => {
  const box = {};
  vm.runInNewContext(`${src}\nglobalThis.api = { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb };`, box);
  const { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } = box.api;
  for (const hex of ['#000000', '#ffffff', '#ff0000', '#16a34a', '#8c4f4f', '#44739e', '#ffc107']) {
    assert.equal(rgbToHex(hsvToRgb(rgbToHsv(hexToRgb(hex)))), hex, hex);
  }
  assert.equal(hexToRgb('nope'), null);
});

test('the popover is placed inside the window, flipping above when needed', () => {
  const box = {};
  vm.runInNewContext(`${src}\nglobalThis.place = place; globalThis.setPop = (p) => { pop = p; };`, box);
  const pos = (anchor, vw, vh) => {
    const popEl = { offsetWidth: 232, offsetHeight: 373, style: {} };
    box.document = { documentElement: { clientWidth: vw, clientHeight: vh } };
    vm.runInNewContext('document = globalThis.document', box);
    box.setPop(popEl);
    box.place({ getBoundingClientRect: () => anchor });
    return { left: parseFloat(popEl.style.left), top: parseFloat(popEl.style.top) };
  };
  // A swatch at the right edge of a phone: kept on screen.
  let p = pos({ left: 360, right: 386, top: 300, bottom: 330 }, 390, 760);
  assert.ok(p.left >= 8 && p.left + 232 <= 382, JSON.stringify(p));
  // Near the bottom: opens above the swatch.
  p = pos({ left: 900, right: 930, top: 650, bottom: 680 }, 1280, 720);
  assert.ok(p.top + 373 <= 650, 'flipped above');
  // A window shorter than the picker: pinned to the top margin, not off screen.
  p = pos({ left: 100, right: 130, top: 100, bottom: 130 }, 1280, 300);
  assert.equal(p.top, 8);
});

test('wired into the editor and Settings', () => {
  assert.match(read('public/js/editor.js'), /initColorPicker\(\); \/\/ colour inputs/);
  assert.match(read('public/editor.html'), /href="color-picker\.css"/);
  const settings = read('public/settings.html');
  assert.match(settings, /href="color-picker\.css"/);
  assert.match(settings, /import \{ initColorPicker \} from '\/js\/editor-color\.js'; initColorPicker\(\);/);
  assert.match(read('public/js/settings-shell.js'), /e\.target\.dataset\.colorPickerEdit === '1'/);
  assert.match(src, /e\.preventDefault\(\); \/\/ no browser popup/);
});
