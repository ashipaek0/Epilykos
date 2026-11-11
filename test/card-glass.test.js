'use strict';
const checks = require('./_checks');
// A card can choose its own glass: on, off or the dashboard's, with its own blur and frost
// (the card's Style settings in the layout editor; blockStyle.js puts them on the card, glass.css draws them).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const B = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/blockStyle.js')).href);

  // Only valid values are kept; a missing one follows the dashboard.
  assert.deepStrictEqual(B.cardGlass(null), {});
  assert.deepStrictEqual(B.cardGlass({}), {});
  assert.deepStrictEqual(B.cardGlass({ glass: 'on', glassBlur: 12, glassFrost: 150 }), { glass: 'on', glassBlur: 12, glassFrost: 150 });
  assert.deepStrictEqual(B.cardGlass({ glass: 'off' }), { glass: 'off' });
  assert.deepStrictEqual(B.cardGlass({ glass: 'maybe', glassBlur: '', glassFrost: null }), {}, 'anything else follows the dashboard; empty is not 0');
  assert.deepStrictEqual(B.cardGlass({ glassBlur: '0' }), { glassBlur: 0 }, 'a blur of 0 is a real value');
  assert.deepStrictEqual(B.cardGlass({ glassBlur: 999, glassFrost: 1 }), { glassBlur: 40, glassFrost: 20 }, 'clamped');
  assert.deepStrictEqual(B.cardGlass({ glassBlur: '1px;}body{x:y', glassFrost: 'abc' }), {}, 'text is never passed on');

  // What goes on the card.
  const fake = () => {
    const classes = new Set(), props = {};
    return { classes, props, classList: { add: c => classes.add(c) }, style: { setProperty: (k, v) => { props[k] = v; }, set background(v) {}, set borderColor(v) {}, set boxShadow(v) {} }, querySelectorAll: () => [] };
  };
  const run = block => { const el = fake(); B.applyBlockStyle(el, block); return { classes: [...el.classes].sort(), props: el.props }; };
  assert.deepStrictEqual(run({}), { classes: [], props: {} }, 'a card with no glass settings is untouched');
  assert.deepStrictEqual(run({ glass: 'on' }), { classes: ['glass-on'], props: {} });
  assert.deepStrictEqual(run({ glass: 'off', glassBlur: 30 }), { classes: ['glass-off', 'glass-own'], props: { '--glass-blur': '30px' } });
  assert.deepStrictEqual(run({ glass: 'on', glassBlur: 8, glassFrost: 150 }), { classes: ['glass-on', 'glass-own'], props: { '--glass-blur': '8px', '--glass-frost': '1.5' } });
  assert.deepStrictEqual(run({ glassFrost: 60 }), { classes: ['glass-own'], props: { '--glass-frost': '0.6' } }, 'own numbers alone: glass only where the dashboard has it');

  // The stylesheet: on and off for one card, on top of the dashboard's.
  const css = read('public/glass.css');
  const scope = ':is(.glass-on, body.glass-cards :not(.glass-off))';
  assert.ok(css.split(scope).length - 1 >= 12, 'every card and tile rule, and the fallbacks, take the scope');
  assert.ok(!/body\.glass-cards \.dashboard-block >/.test(css), 'no rule still needs the dashboard to be glass');
  assert.match(css, /\.dashboard-block > :is\(\.glass-on, \.glass-own\) \{ --glass-tint: calc\(\.36 \* var\(--glass-frost\)\); \}/, 'the tint follows the card\'s own frost');
  assert.match(css, /\[data-theme="dark"\] \.dashboard-block > :is\(\.glass-on, \.glass-own\) \{ --glass-tint: calc\(\.14/);
  assert.match(css, /body:not\(\.glass-cards\) \.dashboard-block > \.glass-on \{ --glass-blur: 18px; --glass-frost: 1;/, 'a glass card on a plain dashboard starts from the usual numbers');

  // The layout editor: the settings sit with the card's Style settings and are saved on the block.
  const ed = read('public/js/editor.js');
  assert.match(ed, /import \{ applyBlockStyle, fontScale, cardGlass \}/);
  assert.match(ed, /'<legend data-ui="legend">Glass<\/legend>'/);
  for (const id of ['modal-glass', 'modal-glassblur', 'modal-glassfrost']) assert.ok(ed.includes(`id="${id}"`), `${id} is in the form`);
  assert.match(ed, /if \(glassChoice === 'on' \|\| glassChoice === 'off'\) config\.glass = glassChoice; else delete config\.glass;/, 'a setting left on the dashboard\'s is removed, not saved empty');
  assert.match(ed, /\['glassBlur', 'modal-glassblur', 0, 40\], \['glassFrost', 'modal-glassfrost', 20, 200\]/, 'typed numbers are kept within the same limits');
  assert.match(ed, /\['glass', 'glassBlur', 'glassFrost'\]\.forEach\(function\(key\) \{\s*\n\s*if \(config\[key\] === undefined\) delete block\[key\]; else block\[key\] = config\[key\];/);
  console.log('ok - a card can set its own glass, blur and frost');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
