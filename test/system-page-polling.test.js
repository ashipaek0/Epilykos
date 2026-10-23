'use strict';
const checks = require('./_checks');
// Settings → System polls every 2 s only while a Bluetooth pairing window is
// open, otherwise every 30 s, and not while the tab or the section is hidden.
// Runs the real appliance-settings.js against a stub page and clock.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../public/js/appliance-settings.js'), 'utf8');

let now = 1_700_000_000_000;
const calls = [];
let bluetooth = { available: true, until: 0, devices: [] };
const el = () => ({ textContent: '', className: '', innerHTML: '', dataset: {}, querySelector: () => null, addEventListener() {} });
const section = { hidden: false };
const docListeners = {};
const root = { ...el(), querySelector: sel => (sel === '#sys-bt-pin' ? null : el()) };
const document = {
  hidden: false,
  getElementById: id => (id === 'sys-root' ? { after() {} } : id === 'section-system' ? section : null),
  createElement: () => root,
  addEventListener: (t, fn) => { docListeners[t] = fn; },
};
let tick = null;
class FakeDate extends Date { static now() { return now; } }
const ctx = {
  document, window: {}, Date: FakeDate, JSON, String, Math, Promise,
  setInterval: (fn) => { tick = fn; return 1; },
  fetch: async (url) => {
    calls.push(url);
    return { ok: true, json: async () => (url === '/api/system' ? { appliance: true, clock: {}, storage: null } : { bluetooth }) };
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const flush = () => new Promise(r => setImmediate(r));

(async () => {
  await flush(); await flush();
  assert.equal(calls.length, 2, 'loads once on open');
  const step = async (ms) => { now += ms; tick(); await flush(); await flush(); };

  for (let i = 0; i < 14; i++) await step(2000);
  assert.equal(calls.length, 2, 'pairing closed: nothing within 30 s');
  await step(2000);
  assert.equal(calls.length, 4, 'then one refresh at 30 s');
  console.log('ok - pairing closed: every 30 s');

  bluetooth = { available: true, until: now / 1000 + 300, devices: [] };
  for (let i = 0; i < 15; i++) await step(2000);   // picks up the open window at the 30 s refresh
  const before = calls.length;
  await step(2000); await step(2000);
  assert.equal(calls.length, before + 4, 'pairing open: every 2 s');
  console.log('ok - pairing open: every 2 s');

  document.hidden = true;
  for (let i = 0; i < 20; i++) await step(2000);
  assert.equal(calls.length, before + 4, 'tab hidden: no requests');
  document.hidden = false; docListeners.visibilitychange();
  await flush(); await flush();
  assert.equal(calls.length, before + 6, 'shown again: refreshes straight away');
  section.hidden = true;
  for (let i = 0; i < 20; i++) await step(2000);
  assert.equal(calls.length, before + 6, 'another Settings section: no requests');
  console.log('ok - nothing while the tab or the System section is hidden');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
