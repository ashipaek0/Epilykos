'use strict';
const checks = require('./_checks');
// The two bar gauge cards (Bar gauge, Bar gauge segmented) can stand their bars up (Orientation: Vertical) and
// choose rounded or square ends (Bar ends). Unset, both look as they always have.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/barGaugeLook.js')).href);

  assert.deepStrictEqual(L.barGaugeLook(undefined), { vertical: false, ends: '' });
  assert.deepStrictEqual(L.barGaugeLook({}), { vertical: false, ends: '' });
  assert.deepStrictEqual(L.barGaugeLook({ orientation: 'vertical', barEnds: 'square' }), { vertical: true, ends: 'square' });
  assert.deepStrictEqual(L.barGaugeLook({ orientation: 'horizontal', barEnds: 'rounded' }), { vertical: false, ends: 'rounded' });
  assert.deepStrictEqual(L.barGaugeLook({ orientation: 'diagonal', barEnds: 'pointy' }), { vertical: false, ends: '' }, 'anything else is the default');
  assert.strictEqual(L.barGaugeClasses({}), '', 'a card with nothing set has no extra classes');
  assert.strictEqual(L.barGaugeClasses({ orientation: 'vertical' }), ' is-vertical');
  assert.strictEqual(L.barGaugeClasses({ orientation: 'vertical', barEnds: 'rounded' }), ' is-vertical bar-ends-rounded');
  assert.strictEqual(L.barGaugeClasses({ barEnds: 'square' }), ' bar-ends-square');

  const fill = () => ({ style: {} });
  let f = fill(); L.setBarFill(f, 40, false); assert.deepStrictEqual(f.style, { width: '40%' }, 'a row fills along its width');
  f = fill(); L.setBarFill(f, 40, true); assert.deepStrictEqual(f.style, { height: '40%', width: '100%' }, 'a column fills up its height');
  L.setBarFill(null, 10, true);   // no bar: nothing happens

  // The cards put the classes on and size the bars the right way.
  const bar = read('public/js/components/barGauge.js'), retro = read('public/js/components/barGaugeRetro.js');
  assert.match(bar, /container\.className = 'bar-gauge-card ep-card' \+ barGaugeClasses\(config\)/);
  assert.match(retro, /container\.className = 'bar-gauge-retro-card ep-card' \+ barGaugeClasses\(config\)/);
  assert.match(bar, /setBarFill\(fill, pct, vertical\)/);
  assert.match(bar, /linear-gradient\(to \$\{vertical \? 'top' : 'right'\}/, 'a gradient runs up a column');
  assert.ok(!/fill\.style\.width/.test(bar), 'the fill is set only through setBarFill');

  // The styles: a vertical card is a row of columns, filled from the bottom; the ends win over the card defaults.
  const css = read('public/cards.css');
  assert.match(css, /:is\(\.bar-gauge-card, \.bar-gauge-retro-card\)\.is-vertical \{ flex-direction: row !important;/);
  assert.match(css, /\.bar-gauge-retro-card\.is-vertical \.bg-retro-segments \{[^}]*flex-direction: column-reverse;/, 'segments are stacked from the bottom up');
  assert.match(css, /\.bar-gauge-card\.bar-ends-square :is\(\.bar-gauge-track, \.bar-gauge-fill\),\s*\n\.bar-gauge-retro-card\.bar-ends-square \.bg-retro-seg \{ border-radius: 0 !important; \}/);
  assert.match(css, /\.bar-gauge-card\.bar-ends-rounded :is\(\.bar-gauge-track, \.bar-gauge-fill\),\s*\n\.bar-gauge-retro-card\.bar-ends-rounded \.bg-retro-seg \{ border-radius: 99px !important; \}/);

  // The layout editor offers both on each card and saves only what is not the default.
  const ed = read('public/js/editor.js');
  assert.match(ed, /import \{ barGaugeLook \} from '\.\/components\/barGaugeLook\.js'/);
  for (const id of ['modal-bargauge-orientation', 'modal-bargauge-ends']) assert.ok(ed.includes(`id="${id}"`), `${id} is in the form`);
  assert.match(ed, /function buildBarGaugeForm\(block\) \{\s*\n\s*var cfg = block\.config \|\| \{\};\s*\n\s*var metrics = cfg\.metrics \|\| \[\];\s*\n\s*var html = buildBarGaugeLookFields\(cfg\);/);
  assert.match(ed, /function buildBarGaugeRetroForm\(block\) \{\s*\n\s*var cfg = block\.config \|\| \{\};\s*\n\s*var metrics = cfg\.metrics \|\| \[\];\s*\n\s*var html = buildBarGaugeLookFields\(cfg\);/);
  assert.match(ed, /case 'bar-gauge': \{\s*\n\s*readBarGaugeLook\(config\);/);
  assert.match(ed, /case 'bar-gauge-retro': \{\s*\n\s*readBarGaugeLook\(config\);/);
  assert.match(ed, /if \(vertical\) config\.orientation = 'vertical'; else delete config\.orientation;/);
  console.log('ok - bar gauges: vertical bars and rounded or square ends');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
