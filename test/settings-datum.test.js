'use strict';
const checks = require('./_checks');
// Settings "Datum" look: wired in, scoped so it can be switched off, and its
// colour tokens keep the contrast the design claims (computed, not assumed).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const html = read('public/settings.html');
const css = read('public/settings-datum.css');
const js = read('public/js/settings-datum.js');

// Wiring: stylesheet after the shell's own, script after the renderers, class on <html>.
assert.ok(html.indexOf('href="settings-datum.css') > html.indexOf('href="settings-shell.css'), 'datum stylesheet loads after the shell stylesheet');
assert.ok(html.indexOf('src="js/settings-datum.js') > html.indexOf('src="js/settings-shell.js'), 'datum script loads after the shell script');
assert.match(html, /<html[^>]*class="dt"/, 'the page opts in to the look from the first paint');

// Scoped: every rule starts from html.dt, so without the class nothing changes.
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@font-face\s*\{[^}]*\}/g, '').replace(/@media[^{]*\{/g, '').replace(/@keyframes[^{]*\{[\s\S]*?\}\s*\}/g, '');
const selectors = stripped.split('}').map(b => b.split('{')[0].trim()).filter(Boolean);
const unscoped = selectors.filter(sel => sel.split(',').some(part => {
  const p = part.trim();
  if (!p || p.startsWith(':root') || p.startsWith('[data-theme')) return false;
  return !p.startsWith('html.dt');
}));
assert.deepEqual(unscoped, [], 'every datum rule is scoped under html.dt: ' + unscoped.slice(0, 3).join(' | '));

// Contrast, from the tokens in the file.
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--dt-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2];
  return out;
}
const light = tokens(css.match(/:root\s*\{([^}]*)\}/)[1]);
const dark = Object.assign({}, light, tokens(css.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/)[1]));
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
for (const [name, t] of [['light', light], ['dark', dark]]) {
  const onBg = (key, min, what) => assert.ok(ratio(t[key], t.bg) >= min, `${name} ${what} ${t[key]} on ${t.bg} is ${ratio(t[key], t.bg).toFixed(2)}:1, needs ${min}`);
  onBg('ink', 7, 'body text');
  onBg('mut', 4.5, 'muted text');
  onBg('edge', 3, 'field edge');
  onBg('acc-ink', 4.5, 'amber text');
  onBg('ok', 4.5, 'ok text');
  onBg('err', 4.5, 'error text');
  assert.ok(ratio(t.acc, t.bg) >= 3, `${name} amber shape needs 3:1 against the page: ${ratio(t.acc, t.bg).toFixed(2)}`);
  assert.ok(ratio(t['on-acc'], t.acc) >= 4.5, `${name} label on the amber button needs 4.5:1: ${ratio(t['on-acc'], t.acc).toFixed(2)}`);
  assert.ok(ratio(t.mut, t.bg2) >= 4.5, `${name} muted text on the hover tint`);
  assert.ok(ratio(t['on-thumb'], t.ok) >= 4.5, `${name} switch thumb on the green track: ${ratio(t['on-thumb'], t.ok).toFixed(2)}`);
}

// The font ships with the app (no third-party request).
assert.ok(fs.existsSync(path.join(__dirname, '..', 'public/fonts/jetbrains-mono-latin-wght-normal.woff2')), 'mono font is bundled');
assert.ok(fs.existsSync(path.join(__dirname, '..', 'public/fonts/JetBrainsMono-OFL.txt')), 'its licence is bundled');
assert.doesNotMatch(css, /https?:\/\//, 'the stylesheet makes no external requests');

// The script moves elements, never clones them, so ids and listeners survive.
assert.doesNotMatch(js, /cloneNode|innerHTML\s*=/, 'bands are built by moving nodes');

checks.done();
