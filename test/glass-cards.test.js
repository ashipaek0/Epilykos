'use strict';
const checks = require('./_checks');
// Settings > Appearance: "Glass cards" (frosted, translucent metric cards) with blur and frost sliders.
// The look itself was checked in a browser (blur, rim, readable text in light and dark); this covers the wiring.
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
const src = read('public/js/dashboard.js');
const fn = src.match(/function applyGlass\(cfg\) \{[\s\S]*?\n\}\n/);
assert.ok(fn, 'applyGlass exists');
function run(cfg) {
  const classes = new Set(), props = {};
  const document = { body: { classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); } },
    style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: k => { delete props[k]; } } } };
  new Function('document', fn[0] + '; applyGlass(arguments[1]);')(document, cfg);
  return { on: classes.has('glass-cards'), props };
}
assert.deepEqual(run({}), { on: false, props: {} }, 'off by default');
assert.deepEqual(run({ glass_cards: 'false', glass_blur: '30' }), { on: false, props: {} });
assert.deepEqual(run({ glass_cards: 'true' }), { on: true, props: { '--glass-blur': '18px', '--glass-frost': '1' } }, 'defaults');
assert.deepEqual(run({ glass_cards: 'true', glass_blur: '25', glass_frost: '150' }).props, { '--glass-blur': '25px', '--glass-frost': '1.5' });
assert.deepEqual(run({ glass_cards: 'true', glass_blur: '9999', glass_frost: '0' }).props, { '--glass-blur': '40px', '--glass-frost': '0.2' }, 'clamped');
assert.deepEqual(run({ glass_cards: 'true', glass_blur: '1px;} body{display:none', glass_frost: 'abc' }).props, { '--glass-blur': '18px', '--glass-frost': '1' }, 'text is never passed on');

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
