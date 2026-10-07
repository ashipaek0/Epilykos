'use strict';
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const exists = p => assert.ok(fs.existsSync(path.join(root, p)), `${p} exists`);
for (const file of ['public/icons/epilykos-mark.svg', 'public/icons/epilykos-mark-light.svg', 'public/icons/epilykos-mark-dark.svg', 'public/favicon.ico', 'public/icons/icon-192.png', 'public/icons/icon-512.png', 'public/icons/icon-maskable-192.png', 'public/icons/icon-maskable-512.png', 'public/icons/apple-touch-icon.png', 'public/icons/splash-1024.png', 'public/icons/splash-1024-dark.png']) exists(file);
const manifest = JSON.parse(read('public/manifest.json'));
for (const size of [192, 512]) {
  assert.ok(manifest.icons.some(i => i.src === `/icons/icon-${size}.png` && i.sizes === `${size}x${size}` && i.type === 'image/png' && i.purpose === 'any'));
  assert.ok(manifest.icons.some(i => i.src === `/icons/icon-maskable-${size}.png` && i.sizes === `${size}x${size}` && i.type === 'image/png' && i.purpose === 'maskable'));
}
assert.equal(manifest.theme_color, '#f5f5f0');
assert.equal(manifest.background_color, '#f5f5f0');
for (const page of ['index','setup','settings']) {
  const html = read(`public/${page}.html`);
  assert.match(html, /rel="icon"[^>]*href="\/favicon\.ico"/);
  assert.match(html, /rel="icon"[^>]*href="\/icons\/epilykos-mark\.svg"/);
  assert.match(html, /rel="apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon\.png"/);
}
// index.html carries the iOS splash-screen links (light + dark)
{
  const html = read('public/index.html');
  assert.match(html, /rel="apple-touch-startup-image"[^>]*href="\/icons\/splash-1024\.png"/);
  assert.match(html, /rel="apple-touch-startup-image"[^>]*href="\/icons\/splash-1024-dark\.png"/);
  assert.match(html, /theme-color" content="#f5f5f0" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /theme-color" content="#111111" media="\(prefers-color-scheme: dark\)"/);
}
// Watch-Grid E mark structure: flat fills only, titled, 6 distinct node colors, no gradients/watermarks/text
for (const file of ['epilykos-mark.svg','epilykos-mark-light.svg','epilykos-mark-dark.svg']) {
  const svg = read(`public/icons/${file}`);
  assert.match(svg, /<title(?:\s[^>]*)?>[^<]+<\/title>/);
  assert.doesNotMatch(svg, /<linearGradient|<radialGradient|watermark/i);
  const circles = [...svg.matchAll(/<circle[^>]*fill="(#[0-9a-fA-F]{3,6})"/g)].map(m => m[1]);
  assert.equal(circles.length, 6, `${file} has 6 node circles`);
  assert.ok(new Set(circles).size >= 4, `${file} uses a genuine color spectrum (>=4 distinct hues across 6 nodes)`);
  const nodePositions = [...svg.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
  for (let i = 0; i < nodePositions.length; i++) {
    for (let j = i + 1; j < nodePositions.length; j++) {
      const [x1, y1, r1] = nodePositions[i], [x2, y2, r2] = nodePositions[j];
      const dist = Math.hypot(x1 - x2, y1 - y2);
      assert.ok(dist >= r1 + r2, `${file} nodes at (${x1},${y1}) and (${x2},${y2}) must not overlap (dist=${dist.toFixed(1)}, radii sum=${r1 + r2})`);
    }
  }
  assert.match(svg, /<path[^>]*stroke=/, `${file} has the connecting-line path`);
}
for (const [file, size] of [['public/icons/icon-192.png',192],['public/icons/icon-512.png',512],['public/icons/icon-maskable-192.png',192],['public/icons/icon-maskable-512.png',512],['public/icons/apple-touch-icon.png',180],['public/icons/splash-1024.png',1024],['public/icons/splash-1024-dark.png',1024]]) {
  const b = fs.readFileSync(path.join(root,file));
  assert.deepEqual([...b.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  assert.equal(b.readUInt32BE(16), size, `${file} width`); assert.equal(b.readUInt32BE(20), size, `${file} height`);
}
const ico = fs.readFileSync(path.join(root,'public/favicon.ico'));
assert.equal(ico.readUInt16LE(0),0); assert.equal(ico.readUInt16LE(2),1); assert.equal(ico.readUInt16LE(4),3);
// maskable icons use the dedicated maskable SVG (content scaled into the safe zone), not the raw mark
assert.match(read('public/icons/epilykos-mark.svg'), /viewBox="0 0 64 64"/);
const sw = read('public/sw.js');
for (const url of ['/icons/epilykos-mark.svg','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-192.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png','/favicon.ico']) { assert.match(sw, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))); exists(`public${url}`); }
for (const page of ['setup','settings']) assert.doesNotMatch(read(`public/${page}.html`), /class="logo-icon">\s*⚡/);
console.log('brand assets: all checks passed');
checks.done();
