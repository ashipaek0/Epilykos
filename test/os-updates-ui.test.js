'use strict';
const checks = require('./_checks');
// Settings → Updates, the EpilykosOS card (OS update design §10.1), running
// the real updates-settings.js against a stub page, fetch and clock: what
// each job state shows, Install disabled while the host lists a blocker,
// password-confirmed Install/Restart with the exact offered package, the
// result after a rollback, and polling every 2 s only while a job runs,
// backing off while the box is away (as during the restart).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../public/js/updates-settings.js'), 'utf8');

const JOB = '11111111-2222-4333-8444-555555555555';
const SHA = 'a'.repeat(64);
let page, offline = false;
const posts = [], timers = [];
const base = { installed: { version: '2.9.0', buildId: '1.1', channel: 'dev' }, status: null, host: { supported: true, app: {} },
  method: { kind: 'epilykos-os' }, auto: true, autoInstall: false, applying: null, lastResult: null };
const osView = (extra) => Object.assign({ version: '0.6', sequence: 11, supported: true, unsupported_reason: null, available: false,
  latest: null, blockers: [], job: null, last_result: null }, extra);

let listener = null;
const root = { innerHTML: '', addEventListener: (t, fn) => { if (t === 'click') listener = fn; }, contains: () => true, querySelectorAll: () => [] };
const dialogBody = { innerHTML: '', querySelector: () => ({ value: 'correct horse battery', focus() {} }) };
const ctx = {
  document: { hidden: false, getElementById: id => (id === 'up-root' ? root : null), createElement: () => dialogBody },
  window: { stShell: { openDialog: async () => ({ value: 'ok' }), toast() {}, setNavBadge() {} }, crypto: { randomUUID: () => 'req-fixed-0001' } },
  JSON, String, Math, Date, Promise, isNaN, Number, Array, Object,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  fetch: async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'POST') { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ os: page.os }) }; }
    if (offline) throw new Error('offline');
    return { ok: true, json: async () => JSON.parse(JSON.stringify(page)) };
  },
};
ctx.window.document = ctx.document;
const flush = () => new Promise(r => setImmediate(r));
const click = async (dataset) => { await listener({ target: { closest: () => ({ disabled: false, id: '', dataset }) } }); await flush(); await flush(); };

(async () => {
  page = Object.assign({}, base, { os: osView() });
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  await flush(); await flush();
  assert.match(root.innerHTML, /EpilykosOS 0\.6/);
  assert.match(root.innerHTML, /Up to date/);
  assert.equal(timers.filter(t => t.ms === 2000).length, 0, 'no polling without a job');
  console.log('ok - up to date: version shown, no polling');

  // A newer system that cannot install yet, then one that can.
  const latest = { version: '0.7', sequence: 12, size: 412345678, sha256: SHA, notes_url: 'https://example.invalid/n' };
  // Each action re-renders from the host's reply (page.os); dismiss is the simplest.
  page.os = osView({ available: true, latest, blockers: ['The running system has not been confirmed healthy since it started'] });
  await click({ osDismiss: JOB });
  assert.match(root.innerHTML, /data-os-install="12" disabled/);
  assert.match(root.innerHTML, /not been confirmed healthy/);
  page.os = osView({ available: true, latest, blockers: [] });
  await click({ osDismiss: JOB });
  assert.match(root.innerHTML, /EpilykosOS 0\.7 is ready<\/b> \(393 MB\)/);
  assert.match(root.innerHTML, /href="https:\/\/example\.invalid\/n"/);
  assert.doesNotMatch(root.innerHTML, /data-os-install="12" disabled/);
  console.log('ok - an available system: size and notes; Install disabled while the host lists a blocker');

  posts.length = 0;
  page.os = osView({ available: true, latest, job: { id: JOB, state: 'downloading', bytes: 125829120, total: 412345678, version: '0.7' } });
  await click({ osInstall: '12' });
  assert.deepEqual(posts[0], { url: '/api/updates/os/install', body: { sequence: 12, sha256: SHA, request_id: 'req-fixed-0001', password: 'correct horse battery' } });
  assert.match(root.innerHTML, /Downloading 120 MB \/ 393 MB/);
  assert.match(root.innerHTML, /data-os-cancel=/);
  assert.match(root.innerHTML, /Monitoring keeps running/);
  const poll = timers.find(t => t.ms === 2000);
  assert.ok(poll, 'polls every 2 s while a job runs');
  console.log('ok - Install sends the offered package with a request ID and the password; progress shown, cancellable');

  timers.length = 0;
  page.os = osView({ job: { id: JOB, state: 'installing', percent: 37, version: '0.7' } });
  await poll.fn(); await flush();
  assert.match(root.innerHTML, /Installing 37 %/);
  assert.doesNotMatch(root.innerHTML, /data-os-cancel=/, 'no cancel once installing');
  const next = timers.find(t => t.ms === 2000);
  offline = true;
  timers.length = 0;
  await next.fn(); await flush();
  assert.equal(timers[0].ms, 4000, 'backs off while the box is away');
  offline = false;
  console.log('ok - installing: percent, no cancel; polling backs off when unreachable');

  posts.length = 0;
  page.os = osView({ job: { id: JOB, state: 'ready', version: '0.7' } });
  await click({ osDismiss: JOB });
  assert.match(root.innerHTML, /Restart to finish/);
  assert.match(root.innerHTML, /goes back to this version by itself/);
  posts.length = 0;
  page.os = osView({ job: { id: JOB, state: 'restarting', version: '0.7' } });
  await click({ osRestart: JOB });
  assert.deepEqual(posts[0], { url: '/api/updates/os/restart', body: { job: JOB, password: 'correct horse battery' } });
  assert.match(root.innerHTML, /Restarting onto the new system/);
  console.log('ok - ready: Restart to finish (password, names the job)');

  page.os = osView({ last_result: { id: JOB, outcome: 'rolled_back', version: '0.7', reason: 'not healthy within 1200 s' } });
  await click({ osDismiss: JOB });
  assert.match(root.innerHTML, /0\.7 didn’t start properly; the box went back to 0\.6 \(not healthy within 1200 s\)/);
  assert.match(root.innerHTML, /data-os-dismiss=/);
  page.os = osView({ last_result: { id: JOB, outcome: 'confirmed', version: '0.7' } });
  await click({ osDismiss: JOB });
  assert.match(root.innerHTML, /Updated to EpilykosOS 0\.7\./);
  console.log('ok - results: rolled back with the reason, or updated, until dismissed');

  page.os = { supported: false, unsupported_reason: 'This card was made before OS updates from Settings. Flash a current EpilykosOS image once to get them.' };
  await click({ osDismiss: JOB });
  assert.match(root.innerHTML, /Flash a current EpilykosOS image once/);
  assert.doesNotMatch(root.innerHTML, /data-os-install/);
  console.log('ok - an older card: the one-time reflash message, no Install');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
