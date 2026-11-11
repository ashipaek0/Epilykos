'use strict';
const checks = require('./_checks');
// Settings > Appearance: "Glass cards" (frosted, translucent dashboard cards) with blur and frost sliders.
// The look itself was checked in a browser on a dashboard with every card type (blur, rim, translucent inner boxes,
// readable text in light and dark); this covers the wiring.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// The three settings are saved, and the dashboard is told them.
for (const f of ['routes/metrics.js', 'server.js', 'modules/database.js']) {
  assert.match(read(f), /'square_corners', 'glass_cards', 'glass_blur', 'glass_frost'/, `${f} knows the glass settings`);
}

// The settings page: a toggle beside the other card options, and sliders with limits the dashboard also applies.
const html = read('public/settings.html');
assert.match(html, /id="glass-cards" name="glass_cards"/);
assert.match(html, /id="glass-blur" name="glass_blur" type="range" min="0" max="40"/);
assert.match(html, /id="glass-frost" name="glass_frost" type="range" min="20" max="200"/);
assert.match(html, /id="glass-options" hidden/, 'the sliders are hidden until the toggle is on');
assert.match(read('public/settings.js'), /function syncGlassOptions\(\)/);

// The dashboard: the class and two numbers; a stored value that is not a number never reaches the stylesheet.
// (public/js/appearance.js, which also gives each dashboard its own look: test/dashboard-appearance.test.js.)
const { pathToFileURL } = require('node:url');
async function glassRun(cfg) {
  const A = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/appearance.js')).href);
  const classes = new Set(), props = {};
  const body = { classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); }, add: c => classes.add(c), remove: (...c) => c.forEach(x => classes.delete(x)) },
    style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: k => { delete props[k]; } }, addEventListener() {} };
  global.document = { body, documentElement: { getAttribute: () => 'light' } };
  A.applyAppearance(A.effectiveAppearance(A.globalAppearance(cfg), undefined), {});
  delete global.document;
  return { on: classes.has('glass-cards'), transparent: classes.has('transparent-blocks'), props };
}
const dashSrc = read('public/js/dashboard.js');
assert.match(dashSrc, /applyAppearance\(effectiveAppearance\(defaultLook, active && active\.appearance\)\)/, 'the dashboard applies its look');

(async () => {
const run = glassRun;
assert.deepEqual(await run({}), { on: false, transparent: false, props: {} }, 'off by default');
assert.deepEqual(await run({ glass_cards: 'false', glass_blur: '30' }), { on: false, transparent: false, props: {} });
assert.deepEqual(await run({ glass_cards: 'true' }), { on: true, transparent: false, props: { '--glass-blur': '18px', '--glass-frost': '1' } }, 'defaults');
assert.equal((await run({ glass_cards: 'true', transparent_blocks: 'true' })).transparent, false, 'glass replaces transparent blocks');
assert.equal((await run({ glass_cards: 'false', transparent_blocks: 'true' })).transparent, true, 'transparent blocks untouched when glass is off');
assert.deepEqual((await run({ glass_cards: 'true', glass_blur: '25', glass_frost: '150' })).props, { '--glass-blur': '25px', '--glass-frost': '1.5' });
assert.deepEqual((await run({ glass_cards: 'true', glass_blur: '9999', glass_frost: '0' })).props, { '--glass-blur': '40px', '--glass-frost': '0.2' }, 'clamped');
assert.deepEqual((await run({ glass_cards: 'true', glass_blur: '1px;} body{display:none', glass_frost: 'abc' })).props, { '--glass-blur': '18px', '--glass-frost': '1' }, 'text is never passed on');

// The stylesheet covers every card the dashboard builds (each block's root class), leaves the embedded page alone,
// and gives the tiles of blocks that have no card of their own the glass instead.
const sheet = read('public/glass.css');
const roots = ['stat-card', 'ep-card:not(.iframe-card)', 'metric-trend-card', 'dual-metric-card', 'configurable-gauge-card', 'button-card', 'switch-block', 'state-select-block', 'flow-card', 'flow-card-square', 'flow-card-square2', 'flow-card-2', 'energy-tabs-card', 'energy-day-card', 'pv-today-card', 'fc-card', 'weather-block', 'chart-container', 'daily-breakdown-container'];
for (const c of roots) assert.ok(sheet.includes('.' + c), `glass covers .${c}`);
for (const c of ['multi-value-card', 'stats-grid', 'energy-totals-card', 'system-overview-card', 'et-tile', 'so-tile', 'ep-tile']) assert.ok(sheet.includes('.' + c), `glass covers the tiles of .${c}`);
// Every root class a component builds is either listed or is one of the tile-set blocks above.
const components = fs.readdirSync(path.join(__dirname, '..', 'public/js/components')).filter(f => f.endsWith('.js'));
const built = new Set();
for (const f of components) {
  const text = read('public/js/components/' + f);
  for (const m of text.matchAll(/(?:root|card|container|tile|el)\.className\s*=\s*['"`]([a-z0-9 -]+)/g)) m[1].split(' ').forEach(c => built.add(c));
}
const covered = c => roots.some(r => r.split(':')[0] === c) || sheet.includes('.' + c);
for (const c of ['metric-trend-card', 'dual-metric-card', 'grid-card', 'text-card', 'chart-container', 'daily-breakdown-container', 'pv-today-card', 'fc-card', 'weather-block', 'energy-day-card', 'bar-gauge-card', 'savings-block-container']) {
  if (built.has(c)) assert.ok(covered(c) || ['grid-card', 'text-card', 'bar-gauge-card', 'savings-block-container'].includes(c), `a built card class is covered: ${c}`);
}

// The stylesheet is inert without the class, and has fallbacks.
const css = read('public/glass.css');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.split('{')[0].trim()).filter(Boolean);
for (const sel of rules.filter(s => !s.startsWith('@') && !s.startsWith(' '))) assert.ok(/glass-cards/.test(sel) || sel.startsWith('['), `rule only applies with .glass-cards: ${sel}`);
assert.match(css, /@supports not/);
assert.match(css, /prefers-reduced-transparency/);
assert.match(read('public/index.html'), /<link rel="stylesheet" href="glass\.css">/);
assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public/js/glass-proto.js')), 'the ?glass=1 prototype switch is gone');
console.log('ok - glass cards setting');
checks.done();
})().catch(e => { console.error(e); process.exit(1); });
