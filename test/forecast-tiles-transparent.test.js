'use strict';
const checks = require('./_checks');
// The day tiles of the solar forecast cards (.fc-day) have their own tint, and are drawn after the forecast arrives, so a
// card's Transparent setting (and the dashboard's Transparent blocks) never reached them. They now take their background
// from --fc-tile, which a transparent card sets.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const css = read('public/style.css');
  assert.match(css, /\.fc-day \{[^}]*background: var\(--fc-tile, color-mix\(in srgb, var\(--border\) 35%, transparent\)\);/, 'the same tint as before unless a card says otherwise');
  assert.match(css, /body\.transparent-blocks \.fc-card \{ --fc-tile: transparent; \}/, 'the dashboard-wide Transparent blocks reaches them');
  assert.ok(!/\.fc-day \{[^}]*background: color-mix/.test(css), 'no fixed tint left on the tile');

  const B = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/blockStyle.js')).href);
  const run = block => { const props = {}; const el = { style: { setProperty: (k, v) => { props[k] = v; }, set background(v) {}, set borderColor(v) {}, set boxShadow(v) {} }, classList: { add() {} }, querySelectorAll: () => [] }; B.applyBlockStyle(el, block); return props; };
  assert.strictEqual(run({ transparent: true })['--fc-tile'], 'transparent', 'a transparent card makes its tiles transparent');
  assert.ok(!('--fc-tile' in run({})), 'a card that is not transparent keeps them');
  assert.ok(!('--fc-tile' in run({ bgColor: '#ff0000' })));
  console.log('ok - the forecast day tiles follow the card\'s transparency');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
