'use strict';
const checks = require('./_checks');
/**
 * Each dashboard can have its own look (background colours and image, transparent blocks, square
 * corners, glass), set in the layout editor's "Dashboard style" panel. What it leaves out follows
 * Settings → Appearance.
 * - the page and the server keep only valid values, by the same rules;
 * - the defaults and a dashboard's overrides merge, and an empty setting is not a 0;
 * - a look puts classes on the body and the background on its element; clearing takes them off;
 * - saving the dashboards drops anything invalid from a dashboard's appearance;
 * - the editor has the panel, previews on the canvas, and the dashboard applies it on every render.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('node:url');
const REPO = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');

function fakeEl() {
  const style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
  return { style, classes: new Set(), classList: { add(...c) { c.forEach(x => this.p.classes.add(x)); }, remove(...c) { c.forEach(x => this.p.classes.delete(x)); }, toggle(c, on) { on ? this.p.classes.add(c) : this.p.classes.delete(c); } }, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
}
function fakeDom(theme = 'light') {
  const body = fakeEl(); body.classList.p = body;
  const html = { getAttribute: () => theme };
  global.document = { body, documentElement: html };
  return { body, setTheme: t => { theme = t; } };
}

(async () => {
  const A = await import(pathToFileURL(path.join(REPO, 'public/js/appearance.js')).href);
  const S = require('../modules/dashboardAppearance');

  // The rules.
  const input = { bgLight: '#FFCC00', bgDark: 'red', bgImage: ' https://x.example/a.png") ', transparentBlocks: true, squareCorners: 'yes', glassCards: false, glassBlur: 99, glassFrost: '5', other: 1 };
  assert.deepStrictEqual(A.cleanOverrides(input), { bgLight: '#ffcc00', bgImage: 'https://x.example/a.png', transparentBlocks: true, glassCards: false, glassBlur: 40, glassFrost: 20 });
  assert.deepStrictEqual(S.sanitizeAppearance(input), A.cleanOverrides(input), 'the server and the page keep the same');
  for (const bad of [null, undefined, 'x', 5, [], {}, { bgLight: 'nope' }, { glassBlur: 'a' }]) {
    assert.deepStrictEqual(A.cleanOverrides(bad), {}, JSON.stringify(bad));
    assert.strictEqual(S.sanitizeAppearance(bad), undefined, JSON.stringify(bad));
  }
  assert.deepStrictEqual(S.sanitizeAppearance({ bgImage: '' }), { bgImage: '' }, 'an empty address is "no image on this dashboard"');
  assert.strictEqual(A.cleanOverrides({ bgImage: 'a'.repeat(5000) }).bgImage.length, 2048);
  assert.strictEqual(A.safeImageUrl('url("x")'), 'urlx');
  console.log('ok - only valid values are kept, by the same rules on the page and the server');

  // The defaults and the merge.
  assert.deepStrictEqual(A.globalAppearance({}), { bgLight: '#f8fafc', bgDark: '#0f172a', bgImage: '', transparentBlocks: false, squareCorners: false, glassCards: false, glassBlur: 18, glassFrost: 100 });
  const base = A.globalAppearance({ dashboard_bg_color_light: '#112233', dashboard_bg_image: 'https://x.example/bg.jpg', transparent_blocks: 'true', glass_blur: '', glass_frost: '' });
  assert.strictEqual(base.bgLight, '#112233'); assert.strictEqual(base.transparentBlocks, true);
  assert.strictEqual(base.glassBlur, 18, 'an empty setting is the default, not 0'); assert.strictEqual(base.glassFrost, 100);
  assert.strictEqual(A.globalAppearance({ dashboard_bg_color: '#abcdef' }).bgLight, '#abcdef', 'the older single colour still counts');
  const own = { bgLight: '#ffffff', bgImage: '', squareCorners: true };
  const eff = A.effectiveAppearance(base, own);
  assert.deepStrictEqual([eff.bgLight, eff.bgImage, eff.squareCorners, eff.bgDark, eff.transparentBlocks], ['#ffffff', '', true, '#0f172a', true], 'overrides win; the rest follows the defaults; "" removes the default image');
  assert.deepStrictEqual(A.effectiveAppearance(base, undefined), base);
  console.log('ok - a dashboard follows the defaults except where it sets its own');

  // Applying.
  let dom = fakeDom('light');
  A.applyAppearance(A.effectiveAppearance(base, { glassCards: false }), {});
  assert.deepStrictEqual([...dom.body.classes], ['transparent-blocks']);
  assert.strictEqual(dom.body.style.backgroundColor, '#112233'); assert.match(dom.body.style.backgroundImage, /^url\("https:\/\/x\.example\/bg\.jpg"\)$/);
  assert.strictEqual(dom.body.style.backgroundAttachment, 'fixed');
  A.applyAppearance(A.effectiveAppearance(base, { glassCards: true, glassBlur: 30, glassFrost: 150, bgImage: '' }), {});
  assert.deepStrictEqual([...dom.body.classes].sort(), ['glass-cards'], 'glass replaces transparent blocks');
  assert.strictEqual(dom.body.style.props['--glass-blur'], '30px'); assert.strictEqual(dom.body.style.props['--glass-frost'], '1.5');
  assert.strictEqual(dom.body.style.backgroundImage, '', 'a dashboard with no image clears the last one');
  A.applyAppearance(A.effectiveAppearance(base, { squareCorners: true, transparentBlocks: false }), {});
  assert.deepStrictEqual([...dom.body.classes], ['square-corners']);
  assert.strictEqual(dom.body.style.props['--glass-blur'], undefined, 'and glass numbers go when glass is off');
  // The theme: dark uses the dark colour, and a theme change repaints.
  dom.setTheme('dark'); dom.body.listeners['theme-changed']();
  assert.strictEqual(dom.body.style.backgroundColor, '#0f172a');
  // A preview on another element (the editor's canvas): the classes go on the body, the background on the canvas.
  dom = fakeDom('light'); const canvas = fakeEl();
  A.applyAppearance(A.effectiveAppearance(base, { bgLight: '#ffcc00' }), { backgroundEl: canvas, fixed: false });
  assert.strictEqual(canvas.style.backgroundColor, '#ffcc00'); assert.strictEqual(dom.body.style.backgroundColor, undefined);
  assert.strictEqual(canvas.style.backgroundAttachment, 'scroll');
  A.clearAppearance({ backgroundEl: canvas });
  assert.strictEqual(canvas.style.backgroundColor, ''); assert.strictEqual(dom.body.classes.size, 0);
  console.log('ok - a look is applied, replaced and cleared, for the page and for the editor canvas');
  delete global.document;

  // Saving.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-appearance-'));
  process.chdir(tmp); process.env.ENC_KEY_FILE = path.join(tmp, 'key');
  const database = require('../modules/database'); database.initializeDatabase();
  const { saveDashboardConfig, getDashboardConfig } = require('../modules/dashboard-config');
  saveDashboardConfig({ dashboards: [
    { id: 'a', name: 'A', layout: [], appearance: { bgLight: '#ffcc00', glassBlur: 99, evil: '<script>', bgDark: 'x' } },
    { id: 'b', name: 'B', layout: [], appearance: { bgLight: 'nope' } },
    { id: 'c', name: 'C', layout: [] }
  ], activeDashboard: 'a' });
  const saved = getDashboardConfig().dashboards;
  assert.deepStrictEqual(saved[0].appearance, { bgLight: '#ffcc00', glassBlur: 40 });
  assert.ok(!('appearance' in saved[1]) && !('appearance' in saved[2]), 'nothing valid: no appearance at all');
  console.log('ok - saving keeps only valid looks');

  // Wiring.
  const dash = read('public/js/dashboard.js'), editor = read('public/js/editor.js');
  assert.match(dash, /applyAppearance\(effectiveAppearance\(defaultLook, active && active\.appearance\), \{ anchored:/);
  assert.match(dash, /function renderDashboard\(\) \{\s*if \(!dashboardConfig[^\n]*\n\s*applyDashboardLook\(\);/, 'every render applies the active dashboard\'s look');
  assert.doesNotMatch(dash, /applyGlass|_bgLight/, 'the old page-wide settings code is gone');
  assert.match(editor, /label: 'Dashboard style…'/); assert.match(editor, /applyEditorLook\(\);\s*\n\s*selectBlock\(opts\.keepSelection/, 'every tab shows its look');
  assert.match(editor, /buildDashboardStyle\(tab\)/); assert.match(editor, /tab && !onControlsTab\(\) && !readOnly/, 'not on the Controls page, not when read-only');
  assert.match(read('public/editor.html'), /href="glass\.css"/);
  assert.match(read('public/editor.css'), /body\.square-corners #ed-canvas/);
  assert.match(read('public/editor.css'), /\.ins-empty \{[^}]*overflow-y: auto/, 'the inspector with nothing selected scrolls: Dashboard style is taller than the column');
  console.log('ok - the editor has the panel and previews on the canvas; the dashboard applies it on every render');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
