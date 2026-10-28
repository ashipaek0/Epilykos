'use strict';
const checks = require('./_checks');
// Where sign-in sends you back to: only this site, whatever the address says.
const assert = require('node:assert/strict');
const { safeNext } = require('../public/js/safe-next.js');
const origin = 'https://box.local:3000';

for (const [given, want] of [
  ['/setup', origin + '/setup'],
  ['/settings#backup', origin + '/settings#backup'],
  ['/settings?tab=security#top', origin + '/settings?tab=security#top'],
  ['', origin + '/'], [null, origin + '/'], [undefined, origin + '/'],
  ['https://box.local:3000/editor', origin + '/editor']
]) assert.equal(safeNext(given, origin), want, JSON.stringify(given));
console.log('ok - a page on this site is where you go back to');

for (const bad of [
  '//evil.example', '/\\evil.example', '\\\\evil.example', '///evil.example',
  '/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\t\\evil.example', '\t//evil.example', ' //evil.example',
  'https://evil.example/', 'http://box.local:3000/', 'https://box.local:3000@evil.example/', 'https://evil.example\\@box.local:3000/',
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', '\u0000//evil.example', 'http:evil.example'
]) {
  const out = safeNext(bad, origin);
  assert.ok(out.startsWith(origin + '/'), `${JSON.stringify(bad)} -> ${out}`);
  assert.ok(!out.startsWith(origin + '//') || new URL(out).host === 'box.local:3000', `${JSON.stringify(bad)} stays on this site`);
  assert.equal(new URL(out).origin, origin, `${JSON.stringify(bad)} stays on this site`);
}
console.log('ok - other sites, protocol-relative addresses (also with tabs and line breaks), backslashes and script addresses all land on this site');

assert.equal(safeNext('/a/../../b', origin), origin + '/b');
assert.equal(new URL(safeNext('/.//evil.example', origin)).host, 'box.local:3000', 'a path that normalises to "//" is still this site');
console.log('ok - paths that normalise oddly stay on this site');
checks.done();
