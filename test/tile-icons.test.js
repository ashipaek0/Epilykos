'use strict';
const checks = require('./_checks');
// Metric cards, Multi-value list rows and the Text metric card can show an icon or image beside the text (the same setting as
// the Button card's icon: an mdi: name, an image address or path, or an emoji). Without one a tile is exactly as it was.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  // A minimal DOM: enough for the helper, which builds nodes rather than markup.
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.classes = new Set(); this.attrs = {}; this.listeners = {}; this.parentNode = null; this.textContent = ''; this.innerHTML = ''; }
    get classList() { const s = this.classes; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) }; }
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    setAttribute(k, v) { this.attrs[k] = v; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    get firstChild() { return this.children[0] || null; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    querySelector(sel) { return sel === ':scope > .tile-icon' ? this.children.find(c => c.classes.has('tile-icon')) || null : null; }
  }
  global.document = { createElement: t => new El(t) };
  const T = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/tileIcon.js')).href);

  assert.strictEqual(T.tileIcon(''), null); assert.strictEqual(T.tileIcon(null), null); assert.strictEqual(T.tileIcon('   '), null);
  const mdi = T.tileIcon('mdi:solar-power');
  assert.ok(mdi.classes.has('tile-icon') && /^<svg viewBox="0 0 24 24"/.test(mdi.innerHTML) && /<path /.test(mdi.innerHTML), 'a built-in icon by name');
  assert.ok(T.tileIcon('solar-power').innerHTML.startsWith('<svg'), 'with or without the mdi: prefix');
  const img = T.tileIcon('https://example.test/panel.png');
  assert.ok(img.classes.has('is-image') && img.children[0].tag === 'img' && img.children[0].src === 'https://example.test/panel.png');
  assert.strictEqual(img.children[0].alt, ''); assert.strictEqual(img.children[0].draggable, false);
  assert.strictEqual(T.tileIcon('/uploads/leaf.png').children[0].src, '/uploads/leaf.png', 'a path on this server');
  assert.strictEqual(T.tileIcon('//cdn.example.test/a.svg').children[0].src, '//cdn.example.test/a.svg');
  const emoji = T.tileIcon('⚡');
  assert.ok(emoji.classes.has('is-emoji') && emoji.textContent === '⚡' && emoji.innerHTML === '');
  // Never markup, never a script address: anything that is not a name, an http(s) or rooted address is just text.
  for (const hostile of ['javascript:alert(1)', '<img src=x onerror=alert(1)>', 'data:text/html,<script>1</script>', 'mdi:<script>']) {
    const el = T.tileIcon(hostile);
    assert.ok(el.classes.has('is-emoji') && el.innerHTML === '' && el.children.length === 0, 'text only: ' + hostile);
  }
  assert.strictEqual(T.tileIcon('abcdefgh').textContent, 'abcd', 'at most four characters of text');

  // On a tile: first child, and the tile says it has one. Without one nothing changes.
  const tile = new El('div'); const label = tile.appendChild(new El('div'));
  assert.strictEqual(T.applyTileIcon(tile, ''), false); assert.ok(!tile.classes.has('has-icon') && tile.children.length === 1);
  assert.strictEqual(T.applyTileIcon(tile, 'mdi:flash'), true);
  assert.ok(tile.classes.has('has-icon')); assert.ok(tile.children[0].classes.has('tile-icon') && tile.children[1] === label, 'before the text');
  // An image that does not load leaves no empty frame.
  const t2 = new El('div'); T.applyTileIcon(t2, 'https://example.invalid/x.png');
  assert.ok(t2.classes.has('has-icon')); t2.children[0].children[0].listeners.error[0]();
  assert.strictEqual(t2.children.length, 0); assert.ok(!t2.classes.has('has-icon'), 'the tile is as it was');
  delete global.document;

  // The cards use it, per tile; the Text metric card keeps having no imports of its own.
  assert.match(read('public/js/components/metricCards.js'), /applyTileIcon\(cardEl, card\.icon\);\s*\n\s*grid\.appendChild\(cardEl\);/);
  assert.match(read('public/js/components/multiValueCard.js'), /applyTileIcon\(card, m\.icon\);\s*\n\s*container\.appendChild\(card\);/);
  assert.ok(!/(^|\n)\s*import\s/.test(read('public/js/components/textMetricCard.js')), 'textMetricCard.js stays import-free');
  assert.match(read('public/js/components/index.js'), /'text-metric': block => \{ const card = buildTextMetricCard\(block\); applyTileIcon\(card, \(block && block\.config \|\| \{\}\)\.icon\); return card; \}/);

  // The styles: the icon beside the text, sized from the card.
  const css = read('public/cards.css');
  assert.match(css, /\.stat-card\.has-icon \{\s*\n\s*display: grid !important; grid-template-columns: auto minmax\(0, 1fr\);[\s\S]*?grid-template-areas: "icon label" "icon value";/);
  assert.match(css, /--tile-icon-size: clamp\(1\.9rem, 5\.2cqi, 3\.4rem\);/, 'it follows the card');
  assert.match(css, /\.tile-icon\.is-image > img \{ width: 100%; height: 100%; object-fit: contain;/);
  assert.match(css, /\.stat-card\.has-icon > :not\(\.tile-icon, \.stat-label, \.stat-value\) \{ grid-column: 1 \/ -1; \}/, 'breakdown lists still span the tile');

  // The layout editor: an icon box on each row (and on the Text metric form), saved only when filled in.
  const ed = read('public/js/editor.js');
  assert.match(ed, /class="mc-icon" value="' \+ escHtml\(c\.icon \|\| ''\)/); assert.match(ed, /class="mv-icon" value="' \+ escHtml\(r\.icon \|\| ''\)/);
  assert.match(ed, /iconField\('modal-textmetric-icon', 'Icon', cfg\.icon \|\| ''/);
  assert.match(ed, /if \(iconEl\) \{ if \(iconEl\.value\.trim\(\)\) mcRows\[m\]\.icon = iconEl\.value\.trim\(\); else delete mcRows\[m\]\.icon; \}/);
  assert.match(ed, /if \(iconEls\[i\]\) \{ if \(iconEls\[i\]\.value\.trim\(\)\) mvRows\[i\]\.icon = iconEls\[i\]\.value\.trim\(\); else delete mvRows\[i\]\.icon; \}/);
  assert.match(ed, /if \(textIcon\) config\.icon = textIcon; else delete config\.icon;/);
  assert.match(ed, /case 'text-metric':\s*\n\s*bindIconPreview\('modal-textmetric-icon'\);/);
  console.log('ok - metric tiles can show an icon or image');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
