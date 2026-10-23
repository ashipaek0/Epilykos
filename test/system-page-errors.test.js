'use strict';
const checks = require('./_checks');
// Settings > System, Bluetooth card: a reply that isn't JSON (the remote
// link's error page while Epilykos restarts) shows a sentence, not a parse
// error, and an error from a refresh clears once a refresh works again.
// Runs the real appliance-settings.js against a stub page.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../public/js/appliance-settings.js'), 'utf8');

const statusEl = { className: '', textContent: '' };
const el = () => ({ textContent: '', className: '', innerHTML: '', dataset: {}, querySelector: () => null, addEventListener() {} });
const root = { ...el(), querySelector: sel => (sel === '[data-status="bt"]' ? statusEl : sel === '#sys-bt-pin' ? null : el()), addEventListener() {} };
const document = {
  hidden: false,
  getElementById: id => (id === 'sys-root' ? { after() {} } : id === 'section-system' ? { hidden: false } : null),
  createElement: () => root,
  addEventListener() {},
};
let mode = 'html';
let tick = null;
const ctx = {
  document, window: {}, Date, JSON, String, Math, Promise,
  setInterval: fn => { tick = fn; return 1; },
  fetch: async url => (mode === 'html'
    ? { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON'); } }
    : { ok: true, status: 200, json: async () => (url === '/api/system' ? { appliance: true, clock: {}, storage: null } : { bluetooth: { available: true, until: 0, devices: [] } }) }),
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

(async () => {
  await flush();
  assert.match(statusEl.textContent, /Epilykos didn’t answer \(it may be restarting\)/);
  assert.doesNotMatch(statusEl.textContent, /Unexpected token|JSON/);
  assert.equal(statusEl.className, 'test-status error');
  console.log('ok - a page instead of data: a sentence saying Epilykos may be restarting');

  mode = 'json';
  ctx.Date = Date;
  // The next refresh (30 s on; force it by asking the timer as if 30 s passed).
  const realNow = Date.now; Date.now = () => realNow() + 31000;
  tick(); await flush();
  Date.now = realNow;
  assert.equal(statusEl.textContent, '', 'cleared once a refresh works');
  console.log('ok - an error from a refresh clears once a refresh works');

  assert.match(src, /var NOT_ANSWERING = /);
  const settings = fs.readFileSync(path.join(__dirname, '../public/settings.js'), 'utf8');
  assert.match(settings, /const body = await res\.json\(\)\.catch\(\(\) => null\);\n\s+if \(!res\.ok \|\| !Array\.isArray\(body\)\) \{/);
  console.log('ok - the Settings Bluetooth scan treats a page instead of data the same way');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
