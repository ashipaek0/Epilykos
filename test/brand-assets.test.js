'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const exists = p => assert.ok(fs.existsSync(path.join(root, p)), `${p} exists`);
for (const file of ['public/icons/epilykos-mark.svg', 'public/icons/epilykos-mark-light.svg', 'public/icons/epilykos-mark-dark.svg', 'public/favicon.ico', 'public/icons/icon-192.png', 'public/icons/icon-512.png', 'public/icons/icon-maskable-192.png', 'public/icons/icon-maskable-512.png', 'public/icons/apple-touch-icon.png']) exists(file);
const manifest = JSON.parse(read('public/manifest.json'));
for (const size of [192, 512]) {
  assert.ok(manifest.icons.some(i => i.src === `/icons/icon-${size}.png` && i.sizes === `${size}x${size}` && i.type === 'image/png' && i.purpose === 'any'));
  assert.ok(manifest.icons.some(i => i.src === `/icons/icon-maskable-${size}.png` && i.sizes === `${size}x${size}` && i.type === 'image/png' && i.purpose === 'maskable'));
}
assert.equal(manifest.theme_color, '#292a24');
for (const page of ['index','setup','settings']) {
  const html = read(`public/${page}.html`);
  assert.match(html, /rel="icon"[^>]*href="\/favicon\.ico"/);
  assert.match(html, /rel="icon"[^>]*href="\/icons\/epilykos-mark\.svg"/);
  assert.match(html, /rel="apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon\.png"/);
}
for (const file of ['epilykos-mark.svg','epilykos-mark-light.svg','epilykos-mark-dark.svg']) {
  const svg = read(`public/icons/${file}`);
  assert.match(svg, /<title(?:\s[^>]*)?>[^<]+<\/title>/);
  assert.doesNotMatch(svg, /<linearGradient|<radialGradient|<text\b|watermark/i);
  assert.equal((svg.match(/class="beam"/g) || []).length, 2);
  assert.match(svg, /id="beam-left"/); assert.match(svg, /id="beam-right"/);
}
for (const [file, size] of [['public/icons/icon-192.png',192],['public/icons/icon-512.png',512],['public/icons/icon-maskable-192.png',192],['public/icons/icon-maskable-512.png',512],['public/icons/apple-touch-icon.png',180]]) {
  const b = fs.readFileSync(path.join(root,file));
  assert.deepEqual([...b.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  assert.equal(b.readUInt32BE(16), size, `${file} width`); assert.equal(b.readUInt32BE(20), size, `${file} height`);
}
const ico = fs.readFileSync(path.join(root,'public/favicon.ico'));
assert.equal(ico.readUInt16LE(0),0); assert.equal(ico.readUInt16LE(2),1); assert.equal(ico.readUInt16LE(4),3);
for (const file of ['public/icons/icon-maskable-192.png','public/icons/icon-maskable-512.png']) assert.match(read('public/icons/epilykos-mark.svg'), /viewBox="0 0 512 512"/), `${file} uses centered safe-zone mark`;
const sw = read('public/sw.js');
for (const url of ['/icons/epilykos-mark.svg','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-192.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png','/favicon.ico']) { assert.match(sw, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))); exists(`public${url}`); }
for (const page of ['setup','settings']) assert.doesNotMatch(read(`public/${page}.html`), /class="logo-icon">\s*⚡/);
console.log('brand assets: all checks passed');
