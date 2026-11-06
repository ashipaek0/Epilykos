'use strict';
const checks = require('./_checks');
// Control card styles (public/js/components/controlStyle.js): layout, sub-label, pill, fill and group
// are read safely, and are wired into the Button and Toggle cards, the editor forms and the stylesheet.
// The layouts themselves were checked in a browser in light, dark and glass.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  // escapeHtml uses the DOM; a tiny stand-in is enough to check the output is escaped.
  global.document = { createElement: () => { const el = { set textContent(v) { this._t = String(v); }, get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; return el; } };
  const { controlStyle, styleClasses, subLabelHtml, LAYOUTS, DEFAULT_LAYOUT, groupOf, filterChips, matchesFilter, layoutLabel } =
    await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/controlStyle.js')).href);

  // A card with no style options looks as it always did.
  assert.deepEqual(controlStyle({}, 'button-card'), { layout: 'centered', sublabel: '', pill: false, fill: false, group: '' });
  assert.deepEqual(controlStyle({}, 'switch-block'), { layout: 'classic', sublabel: '', pill: false, fill: false, group: '' });
  assert.equal(styleClasses(controlStyle({}, 'button-card'), 'button-card'), '', 'the default layout adds no classes');
  assert.equal(styleClasses(controlStyle({}, 'switch-block'), 'switch-block'), '');

  // Layouts: only the ones offered for that card type.
  assert.equal(controlStyle({ layout: 'tile' }, 'button-card').layout, 'tile');
  assert.equal(controlStyle({ layout: 'row' }, 'switch-block').layout, 'row');
  assert.equal(controlStyle({ layout: 'row' }, 'numctl').layout, 'classic', 'a slider has no row layout');
  assert.equal(controlStyle({ layout: 'bogus' }, 'button-card').layout, 'centered');
  assert.equal(controlStyle({ layout: 'centered' }, 'switch-block').layout, 'classic');
  for (const [kind, list] of Object.entries(LAYOUTS)) assert.ok(list.includes(DEFAULT_LAYOUT[kind]), kind + ' default is one of its layouts');

  // The pill follows the layout unless set.
  assert.equal(controlStyle({ layout: 'tile' }, 'button-card').pill, true);
  assert.equal(controlStyle({ layout: 'row' }, 'button-card').pill, true);
  assert.equal(controlStyle({ layout: 'compact' }, 'button-card').pill, false);
  assert.equal(controlStyle({ layout: 'tile', pill: false }, 'button-card').pill, false);
  assert.equal(controlStyle({ pill: true }, 'button-card').pill, true);

  // Classes.
  assert.equal(styleClasses(controlStyle({ layout: 'tile' }, 'button-card'), 'button-card'), 'cs cs-tile');
  assert.equal(styleClasses(controlStyle({ layout: 'tile', fill: true }, 'button-card'), 'button-card'), 'cs cs-tile cs-fill');
  assert.equal(styleClasses(controlStyle({ fill: true }, 'switch-block'), 'switch-block'), 'cs cs-fill');

  // Text: trimmed, one line, short; escaped on output.
  const s = controlStyle({ sublabel: '  Living\n  room  ', group: 'x'.repeat(50) }, 'button-card');
  assert.equal(s.sublabel, 'Living room'); assert.equal(s.group.length, 24);
  assert.equal(controlStyle({ sublabel: 'y'.repeat(100) }).sublabel.length, 40);
  assert.equal(controlStyle({ sublabel: null, group: undefined }).sublabel, '');
  assert.equal(subLabelHtml(controlStyle({}), 'bc-sub'), '');
  const html = subLabelHtml(controlStyle({ sublabel: '<img onerror=x>' }), 'bc-sub');
  assert.ok(html.includes('&lt;img') && !html.includes('<img'), 'the sub-label is escaped');
  console.log('ok - style settings');

  // Slider, knob and State select: classic and tile only; their own words for the tile.
  assert.deepEqual([controlStyle({}, 'numctl').layout, controlStyle({ layout: 'tile' }, 'numctl').layout, controlStyle({ layout: 'compact' }, 'numctl').layout], ['classic', 'tile', 'classic']);
  assert.equal(controlStyle({ layout: 'tile' }, 'state-select').layout, 'tile');
  assert.equal(controlStyle({ fill: true }, 'numctl').fill, true);
  assert.equal(styleClasses(controlStyle({ layout: 'tile', fill: true }, 'numctl'), 'numctl'), 'cs cs-tile cs-fill');
  assert.notEqual(layoutLabel('numctl', 'tile'), layoutLabel('button-card', 'tile'));
  assert.notEqual(layoutLabel('state-select', 'tile'), layoutLabel('numctl', 'tile'));
  assert.equal(layoutLabel('button-card', 'row'), layoutLabel('switch-block', 'row'));

  // Filter chips on the Controls page.
  const B = (group) => ({ config: group === undefined ? {} : { group } });
  assert.equal(groupOf({ group: '  Living   room ' }), 'Living room'); assert.equal(groupOf(null), ''); assert.equal(groupOf({ group: 'z'.repeat(40) }).length, 24);
  assert.deepEqual(filterChips([B(), B('')]), [], 'no groups, no chips');
  assert.deepEqual(filterChips([]), []); assert.deepEqual(filterChips(null), []);
  assert.deepEqual(filterChips([B('Lights'), B('Water'), B('Lights')]), ['Lights', 'Water'], 'in order, no repeats');
  assert.deepEqual(filterChips([B('Lights'), B(), B('Water')]), ['Lights', 'Water', ''], 'cards with no group get "Other" (the empty name)');
  assert.equal(matchesFilter(B('Lights'), null), true, 'All shows everything');
  assert.equal(matchesFilter(B('Lights'), 'Lights'), true); assert.equal(matchesFilter(B('Water'), 'Lights'), false);
  assert.equal(matchesFilter(B(), ''), true, 'Other shows the cards with no group'); assert.equal(matchesFilter(B('Lights'), ''), false);
  console.log('ok - filter chips');

  // Wired in.
  const bc = read('public/js/components/buttonCard.js'), sw = read('public/js/components/switchBlock.js');
  for (const [name, src] of [['button card', bc], ['toggle card', sw]]) {
    assert.ok(src.includes("from './controlStyle.js'"), name + ' imports the style helpers');
    assert.ok(src.includes('styleClasses('), name + ' sets the style classes');
  }
  assert.ok(bc.includes('bc-pill') && bc.includes('bc-sub'));
  assert.ok(sw.includes('cs-sub'));
  const ed = read('public/js/editor.js');
  assert.ok(ed.includes("controlStyleFields(cfg, 'button-card', 'modal-btn')"), 'button form has the style fields');
  assert.ok(ed.includes("controlStyleFields(cfg, 'switch-block', 'modal-switch')"), 'toggle form has the style fields');
  assert.equal((ed.match(/readControlStyle\(config/g) || []).length >= 2, true, 'both save cases read the style fields');
  const css = read('public/cards.css');
  for (const sel of ['.button-card.cs-tile', '.button-card.cs-row', '.button-card.cs-compact', '.switch-block.cs-tile', '.switch-block.cs-row', '.switch-block.cs-compact', '.cs-fill', '.bc-pill'])
    assert.ok(css.includes(sel), 'stylesheet has ' + sel);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public/_ctl-preview.html')), 'no preview page left behind');
  for (const f of ['sliderCard', 'rotaryCard', 'stateSelectBlock']) {
    const src = read(`public/js/components/${f}.js`);
    assert.ok(src.includes("from './controlStyle.js'") && src.includes('styleClasses(') && src.includes('subLabelHtml('), f + ' uses the style options');
  }
  assert.ok(ed.includes("controlStyleFields(cfg, 'numctl', 'modal-num')") && ed.includes("controlStyleFields(cfg, 'state-select', 'modal-state')"), 'slider, knob and selector forms have the style fields');
  assert.ok(ed.includes("readControlStyle(config, 'numctl', 'modal-num')") && ed.includes("readControlStyle(config, 'state-select', 'modal-state')"), 'and save them');
  for (const sel of ['.numctl.cs-tile', '.numctl-slider.cs-tile', '.numctl-rotary.cs-tile', '.state-select-block.cs-tile', '.numctl.cs-fill']) assert.ok(css.includes(sel), 'stylesheet has ' + sel);
  const page = read('private/pages/controls.html'), ctl = read('private/js/controls.js');
  assert.ok(page.includes('id="ct-filters"'), 'the page has the chip row');
  assert.ok(ctl.includes('filterChips(') && ctl.includes('matchesFilter('), 'the Controls page filters by group');
  assert.ok(read('private/css/private.css').includes('.ct-filter'), 'chip styles');
  console.log('ok - wiring');
  checks.done && checks.done();
})().catch(e => { console.error(e); process.exit(1); });
