'use strict';

/**
 * Tuya setup after the settings redesign: Add source → Tuya must open the
 * Smart Life login and scan (it used to make an empty manual card in
 * device view, where the login is hidden), a device view links back to it,
 * the UID isn't a saved change, and the login QR is drawn by the server
 * (the token must not go to a third-party QR site).
 *
 * Run: node --test test/tuya-setup-flow.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = read('public/settings.html');

test('Add source → Tuya opens the account and scan view', () => {
  const shell = read('public/js/settings-shell.js');
  assert.match(shell, /if \(key === 'tuya'\) \{[\s\S]*?go\('sources\/tuya'\)[\s\S]*?return;/);
});

test('the Smart Life login is reachable from a device and not counted as an unsaved change', () => {
  assert.match(html, /class="tuya-panel st-type-extra" data-own-save/);
  assert.match(html, /class="st-help st-type-device-only"><a class="help-link" href="#sources\/tuya">/);
  assert.match(read('public/settings-shell.css'), /\.st-type-panel:not\(\.is-device-view\) \.st-type-device-only \{ display: none/);
});

test('the login QR is drawn by the server, not a third-party site', async () => {
  const js = read('public/settings.js');
  assert.ok(!/qrserver|create-qr-code/.test(js + html), 'no external QR service');
  assert.match(js, /tuyaQrImg\.src = 'data:image\/svg\+xml/);
  assert.match(read('server.js'), /result\.qr_svg = await require\('qrcode'\)\.toString\(result\.qr_url, \{ type: 'svg'/);
  const svg = await require('qrcode').toString('tuyaSmart--qrLogin?token=abc', { type: 'svg', margin: 1, width: 220 });
  assert.match(svg, /^<svg[\s\S]*<\/svg>\s*$/);
});
