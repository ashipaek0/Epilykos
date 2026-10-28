'use strict';
const checks = require('./_checks');
// Settings → Branding → Favicon URL: the custom icon is the ONLY icon link
// (the page ships an .ico and an .svg, and browsers pick between them).
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

function fakeDocument(html) {
  const links = [];
  const head = {
    appendChild(l) { links.push(l); l.parent = head; },
    get links() { return links; }
  };
  const make = (rel, href, type) => { const l = { rel, href, type, listeners: {}, addEventListener(n, f) { l.listeners[n] = f; }, remove() { const i = links.indexOf(l); if (i >= 0) links.splice(i, 1); } }; return l; };
  for (const [rel, href, type] of html) head.appendChild(make(rel, href, type));
  return {
    head, make,
    createElement: () => make('', ''),
    querySelectorAll(sel) { assert.equal(sel, 'link[rel~="icon"]'); return links.filter(l => l.rel.split(' ').includes('icon')); }
  };
}

(async () => {
  const { applyFavicon } = await import(pathToFileURL(path.join(__dirname, '../public/js/favicon.js')).href);
  const page = () => fakeDocument([['icon', '/favicon.ico'], ['icon', '/icons/epilykos-mark.svg', 'image/svg+xml'], ['apple-touch-icon', '/icons/apple-touch-icon.png']]);

  let doc = page();
  applyFavicon(doc, 'https://example.com/mine.png');
  const icons = doc.head.links.filter(l => l.rel === 'icon');
  assert.equal(icons.length, 1, 'one icon link, so nothing else can win');
  assert.equal(icons[0].href, 'https://example.com/mine.png');
  assert.ok(!icons[0].type, 'no leftover type="image/svg+xml" on a PNG');
  assert.equal(doc.head.links.filter(l => l.rel === 'apple-touch-icon').length, 1, 'the home-screen icon is left alone');
  console.log('ok - a custom favicon replaces both built-in icon links');

  // The address does not load: the built-in icons come back.
  icons[0].listeners.error();
  assert.deepEqual(doc.head.links.filter(l => l.rel === 'icon').map(l => l.href).sort(), ['/favicon.ico', '/icons/epilykos-mark.svg']);
  assert.ok(!doc.head.links.some(l => l.href === 'https://example.com/mine.png'));
  console.log('ok - if the address does not load, the built-in icons come back');

  for (const empty of ['', null, undefined]) {
    doc = page(); applyFavicon(doc, empty);
    assert.deepEqual(doc.head.links.filter(l => l.rel === 'icon').map(l => l.href), ['/favicon.ico', '/icons/epilykos-mark.svg'], 'nothing set: nothing changes');
  }
  console.log('ok - with no custom favicon the page keeps its own');

  const dash = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8');
  assert.match(dash, /import \{ applyFavicon \} from '\.\/favicon\.js';/);
  assert.match(dash, /applyFavicon\(document, cfg\.dashboard_favicon\);/);
  assert.doesNotMatch(dash, /querySelector\('link\[rel="icon"\]'\)/, 'no longer edits just the first icon link');
  console.log('ok - the dashboard uses it');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
