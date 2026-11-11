'use strict';
const checks = require('./_checks');
// A dashboard can scale to the screen width (its grid.scale, "Scale to screen width" in the layout editor): its rows, the
// space between blocks and the background picture shrink with the width, and the picture is anchored to the layout area on
// the dashboard and in the editor, so a block sits on the same part of it on any screen. Off, nothing changes. Also: the
// editor draws a dashboard without free placement where it is saved (it used to pack it upward as it loaded).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/layoutGrid.js')).href);
  const S = require('../modules/dashboardGrid');

  // The setting: a boolean, kept the same way on the page and on the server.
  assert.strictEqual(M.STANDARD_GRID.scale, false, 'off by default');
  for (const [raw, want] of [[{ scale: true }, { scale: true }], [{ scale: false }, { scale: false }], [{ scale: 'yes' }, {}], [{ scale: 1 }, {}], [{ scale: null }, {}]]) {
    assert.deepStrictEqual(M.cleanGrid(raw), want, JSON.stringify(raw));
    assert.deepStrictEqual(S.sanitizeGrid(raw) || {}, want, 'server: ' + JSON.stringify(raw));
  }
  assert.strictEqual(M.gridOf({ grid: { scale: true } }).scale, true);
  assert.strictEqual(M.gridOf({}).scale, false);
  assert.strictEqual(M.gridOf({ grid: { gap: 4 } }).scale, false, 'a dashboard that says nothing about it does not scale');
  assert.strictEqual(M.SCALE_REFERENCE_WIDTH, 1400, 'the widest the dashboard gets');
  const config = { dashboards: [{ id: 'a', layout: [], grid: { scale: true, bogus: 1 } }, { id: 'b', layout: [], grid: { scale: 'x' } }] };
  S.sanitizeGrids(config);
  assert.deepStrictEqual(config.dashboards.map(d => d.grid), [{ scale: true }, undefined], 'saving keeps only a valid setting');

  // The placement: unscaled is exactly as before; scaled multiplies every px length by --s, and columns stay a share of the width.
  const item = { x: 2, top: 3, w: 4, h: 2 };
  assert.deepStrictEqual(M.blockStyle(item, M.STANDARD_GRID), { left: 'calc(16.666666666666664% + 1px)', top: '151px', width: 'calc(33.33333333333333% - 2px)', height: '98px' });
  assert.deepStrictEqual(M.blockStyle(item, { ...M.STANDARD_GRID, scale: false }), M.blockStyle(item, M.STANDARD_GRID));
  assert.deepStrictEqual(M.blockStyle(item, { ...M.STANDARD_GRID, scale: true }), {
    left: 'calc(16.666666666666664% + calc(1px * var(--s, 1)))', top: 'calc(151px * var(--s, 1))',
    width: 'calc(33.33333333333333% - calc(2px * var(--s, 1)))', height: 'calc(98px * var(--s, 1))'
  });
  // Evaluated at the reference width (--s = 1) a scaled dashboard is the unscaled one; at half the width every length halves.
  const evaluate = (style, width, s) => {
    const calc = v => { // only the forms blockStyle writes: px, %, calc(), var(--s, 1) and +/-
      let t = String(v).replace(/var\(--s, 1\)/g, String(s));
      t = t.replace(/calc/g, '');
      t = t.replace(/(-?[\d.]+)%/g, (_, n) => `(${n} * ${width} / 100)`).replace(/(-?[\d.]+)px/g, '$1');
      return Function(`return (${t})`)();
    };
    return Object.fromEntries(Object.entries(style).map(([k, v]) => [k, calc(v)]));
  };
  const near = (a, b, what) => { for (const k of Object.keys(a)) assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${what} ${k}: ${a[k]} vs ${b[k]}`); };
  for (const grid of [M.STANDARD_GRID, { ...M.STANDARD_GRID, columns: 24, rowHeight: 25, gap: 8 }, { ...M.STANDARD_GRID, columns: 60, rowHeight: 10, gap: 0 }]) {
    near(evaluate(M.blockStyle(item, { ...grid, scale: true }), 1400, 1), evaluate(M.blockStyle(item, grid), 1400, 1), 'at the reference width');
    near(evaluate(M.blockStyle(item, { ...grid, scale: true }), 700, 0.5), Object.fromEntries(Object.entries(evaluate(M.blockStyle(item, grid), 1400, 1)).map(([k, v]) => [k, v / 2])), 'at half the width');
  }
  assert.strictEqual(M.areaHeight(M.placeBlocks([{ x: 0, y: 0, w: 4, h: 3 }], M.STANDARD_GRID)), 150, 'the area height stays in unscaled px (the stylesheet scales it)');

  // Loose blocks: those with empty space above them, which packing upward would move.
  const L = (x, y, w, h) => ({ gridX: x, gridY: y, gridW: w, gridH: h });
  assert.strictEqual(M.looseBlocks([]), 0);
  assert.strictEqual(M.looseBlocks([L(0, 0, 4, 3), L(0, 3, 4, 3)]), 0, 'stacked blocks rest on each other');
  assert.strictEqual(M.looseBlocks([L(0, 0, 4, 3), L(8, 0, 4, 3), L(4, 0, 4, 2)]), 0, 'a row');
  assert.strictEqual(M.looseBlocks([L(0, 0, 4, 3), L(8, 4, 4, 3), L(4, 9, 4, 2)]), 2, 'two blocks hang below empty space');
  assert.strictEqual(M.looseBlocks([L(0, 2, 4, 3)]), 1, 'a block with nothing above it and not at the top');
  assert.strictEqual(M.looseBlocks([L(0, 0, 4, 3), L(2, 5, 4, 2)]), 1, 'resting on a block only counts if it is directly under it');
  assert.strictEqual(M.looseBlocks([L(0, 0, 4, 3), L(2, 3, 4, 2)]), 0);
  assert.strictEqual(M.looseBlocks([{ gridX: 'a' }, {}]), 0, 'incomplete blocks are ignored');
  // Property: packing a layout upward (what the editor does) moves exactly the loose blocks, when there are any.
  const pack = layout => { const out = layout.map(b => ({ ...b })).sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX); for (const b of out) { let y = 0; for (const o of out) { if (o === b || o.gridY >= b.gridY && o !== b && out.indexOf(o) > out.indexOf(b)) continue; if (o !== b && b.gridX + b.gridW > o.gridX && b.gridX < o.gridX + o.gridW && out.indexOf(o) < out.indexOf(b)) y = Math.max(y, o.gridY + o.gridH); } b.gridY = y; } return out; };
  let seed = 11; const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t < 300; t++) {
    const layout = [];
    for (let i = 0, n = 1 + Math.floor(rand() * 6); i < n; i++) {
      const w = 1 + Math.floor(rand() * 5), x = Math.floor(rand() * (13 - w)), h = 1 + Math.floor(rand() * 4);
      let y = Math.floor(rand() * 10);
      while (layout.some(o => x + w > o.gridX && x < o.gridX + o.gridW && y + h > o.gridY && y < o.gridY + o.gridH)) y++;   // no overlaps
      layout.push(L(x, y, w, h));
    }
    const moved = pack(layout).some(b => !layout.some(o => o.gridX === b.gridX && o.gridY === b.gridY && o.gridW === b.gridW && o.gridH === b.gridH));
    assert.strictEqual(M.looseBlocks(layout) > 0, moved, JSON.stringify(layout));
  }
  console.log('ok - the scale setting, scaled placement and loose blocks');

  // The picture, anchored: classes and variables on the layout area; the page keeps its copy for phones.
  const A = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/appearance.js')).href);
  const el = () => { const classes = new Set(), props = {}; return { classes, props, style: { setProperty: (k, v) => { props[k] = v; }, getPropertyValue: k => props[k] || '', removeProperty: k => { delete props[k]; } }, classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } }; };
  const canvas = { ...el(), style: {} }, area = el();
  const body = el(); body.style = { ...body.style, setProperty() {}, removeProperty() {} };
  global.document = { body: { ...body, addEventListener() {}, getAttribute: () => 'light' }, documentElement: { getAttribute: () => 'light' } };
  global.Image = class { set src(url) { this.onload && setTimeout(() => { this.naturalWidth = 1600; this.naturalHeight = 1000; this.onload(); }, 0); } };
  const look = A.effectiveAppearance(A.globalAppearance({}), { bgImage: 'https://example.test/house.png' });
  const background = {}; const backgroundEl = { style: background };
  A.applyAppearance(look, { backgroundEl, fixed: false, anchored: { el: area, fallback: false } });
  assert.strictEqual(background.backgroundImage, '', 'the picture is not on the page or canvas when it is anchored without a fallback');
  assert.strictEqual(area.props['--pic-url'], 'url("https://example.test/house.png")');
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(area.props['--pic-ratio'], '1.6'); assert.ok(area.classes.has('has-picture'), 'drawn once it is known to load');
  A.applyAppearance(look, { backgroundEl, fixed: true, anchored: { el: area, fallback: true } });
  assert.strictEqual(background.backgroundImage, 'url("https://example.test/house.png")', 'with a fallback the page keeps it too (phones)');
  A.applyAppearance(look, { backgroundEl, fixed: true });
  assert.ok(!area.classes.has('has-picture') && !('--pic-url' in area.props) && !('--pic-ratio' in area.props), 'a dashboard that does not scale takes it back off the area');
  assert.strictEqual(background.backgroundImage, 'url("https://example.test/house.png")');
  A.applyAppearance(A.effectiveAppearance(A.globalAppearance({}), { bgImage: '' }), { backgroundEl, anchored: { el: area, fallback: true } });
  assert.ok(!area.classes.has('has-picture'), 'no picture, nothing anchored');
  delete global.document; delete global.Image;
  console.log('ok - the picture is anchored to the layout area for a dashboard that scales');

  // The dashboard page, its stylesheet and the editor.
  const dash = read('public/js/dashboard.js'), css = read('public/style.css'), edCss = read('public/editor.css'), ed = read('public/js/editor.js');
  assert.match(dash, /import \{ gridOf, placeBlocks, blockStyle, areaHeight, SCALE_REFERENCE_WIDTH \} from/);
  assert.match(dash, /if \(grid\.scale\) \{[\s\S]*?container\.style\.height = '';[\s\S]*?setProperty\('--extent', String\(areaHeight\(rendered, grid\)\)\);[\s\S]*?trackScale\(container\);[\s\S]*?\} else \{\s*\n\s*container\.style\.height = areaHeight\(rendered, grid\) \+ 'px';/, 'unscaled dashboards keep their px height');
  assert.match(dash, /container\.classList\.toggle\('is-scaled', !!grid\.scale\)/);
  assert.match(dash, /document\.body\.classList\.toggle\('scale-layout', scaled\);\s*\n\s*applyAppearance\(effectiveAppearance\(defaultLook, active && active\.appearance\), \{ anchored: scaled && area \? \{ el: area, fallback: true \} : null \}\)/);
  assert.match(dash, /area\.clientWidth \/ SCALE_REFERENCE_WIDTH/); assert.match(dash, /new ResizeObserver\(/, 'the scale follows the window');
  assert.match(css, /#dashboard-container\.is-scaled \{ height: calc\(var\(--extent, 0\) \* 1px \* var\(--s, 1\)\); \}/);
  assert.match(css, /max\(calc\(var\(--extent, 0\) \* 1px \* var\(--s, 1\)\), calc\(var\(--s, 1\) \* 1400px \/ var\(--pic-ratio, 1\)\)\)/, 'tall enough for the picture');
  assert.match(css, /#dashboard-container\.is-scaled\.has-picture::before \{[^}]*width: 100%; aspect-ratio: var\(--pic-ratio, 1\);[^}]*background: var\(--pic-url\) 0 0 \/ 100% 100% no-repeat;/, 'as wide as the area, from its top left');
  assert.match(css, /@media \(min-width: 769px\) \{ body\.scale-layout \{ background-image: none !important; \} \}/, 'the page copy is for phones only');
  assert.match(css, /@media \(max-width: 768px\) \{\s*\n\s*#dashboard-container\.is-scaled::before \{ display: none; \}/, 'phones stack the blocks: no picture on the area');
  assert.match(edCss, /#grid\.has-picture::before \{[^}]*aspect-ratio: var\(--pic-ratio, 1\);[^}]*background: var\(--pic-url\) 0 0 \/ 100% 100% no-repeat;/);
  assert.match(ed, /var k = editorGrid\.scale \? el\.clientWidth \/ SCALE_REFERENCE_WIDTH : Math\.min\(1, el\.clientWidth \/ dashboardWidth\(\)\);/, 'the editor shows the fixed picture shrunk to fit');
  assert.match(ed, /var anchored = editorGrid\.scale && \$\('grid'\) \? \{ el: \$\('grid'\), fallback: false \} : null;/);
  assert.match(ed, /toggle\('dg-scale', 'Scale to screen width', !!g\.scale, false\)/);
  assert.match(ed, /scale\.addEventListener\('change', function\(\) \{ setGrid\(\{ scale: scale\.checked \}\); \}\)/);
  assert.match(ed, /if \(!gridIsFree\(\)\) \{ grid\.opts\.mode = 'top'; grid\.engine\._mode = 'top'; \}/, 'packing upward starts after the blocks are drawn where they are saved');
  assert.match(ed, /!gridIsFreeFor\(g\) && looseBlocks\(tab\.layout\)/, 'and the panel says when cards have space above them');
  console.log('ok - the dashboard, its stylesheets and the editor draw a scaled dashboard');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
