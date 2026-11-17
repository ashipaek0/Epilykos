'use strict';
const checks = require('./_checks');
// Settings → Updates, app update progress (the real updates-settings.js on a
// stub page and clock). On EpilykosOS the steps follow the host's job state;
// while Epilykos itself is away the page shows it restarting. On Docker the
// download happens during the request, then the restart, then the helper's
// health check. No step is shown as done before it is.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../public/js/updates-settings.js'), 'utf8');

function page(kind) {
  const timers = [];
  let listener = null, getReply = null, postReply = null;
  const root = { innerHTML: '', addEventListener: (t, fn) => { if (t === 'click') listener = fn; }, contains: () => true, querySelectorAll: () => [] };
  const ctx = {
    document: { hidden: false, getElementById: id => (id === 'up-root' ? root : null),
      createElement: () => ({ innerHTML: '', querySelector: () => ({ value: 'pw', focus() {} }) }) },
    window: { stShell: { openDialog: async () => ({ value: 'ok' }), toast() {}, setNavBadge() {} } },
    JSON, String, Math, Date, Promise, isNaN, Number, Array, Object,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    fetch: async (url, opts) => {
      if (opts && opts.method === 'POST') { const r = await postReply; return { ok: true, json: async () => r }; }
      const r = getReply();
      if (r instanceof Error) throw r;
      return { ok: true, json: async () => JSON.parse(JSON.stringify(r)) };
    },
  };
  const base = { installed: { version: '2.9.0', buildId: '1.1', channel: 'dev', builtAt: '2026-10-01T00:00:00Z' },
    status: kind === 'docker' ? { state: 'available', latest: { version: '3.0', builtAt: '2026-10-20T00:00:00Z' } } : null,
    host: kind === 'host' ? { supported: true, app: { available: true, latest_version: '3.0' } } : null,
    method: { kind: kind === 'host' ? 'epilykos-os' : 'docker' }, auto: true, applying: null, lastResult: null, os: null };
  vm.createContext(ctx);
  return {
    root, timers, base,
    get: fn => { getReply = fn; }, post: p => { postReply = p; },
    start() { vm.runInContext(src, ctx); },
    click: (dataset, id = '') => listener({ target: { closest: () => ({ disabled: false, id, dataset }) } }),
    async tick() { const t = timers.shift(); await t.fn(); await flush(); },
  };
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
const step = (html, n) => html.match(/<li class="is-now">([^<]*)<\/li>/)?.[1];

(async () => {
  // ── EpilykosOS: the host installs the app ──────────────────────────────
  const host = page('host');
  host.get(() => host.base);
  host.start(); await flush();
  host.post(Promise.resolve({ state: 'applying' }));
  await host.click({ hostApply: 'app' }); await flush();
  assert.equal(step(host.root.innerHTML), 'Downloading the new version');
  host.get(() => ({ ...host.base, applying: { startedAt: '2026-10-24T10:00:00Z', step: 'downloading' } }));
  await host.tick();
  assert.equal(step(host.root.innerHTML), 'Downloading the new version', 'the host is still downloading');
  assert.match(host.root.innerHTML, /<progress class="up-progress" aria-label="Working"><\/progress>/, 'no size known yet: a moving bar');
  host.get(() => ({ ...host.base, applying: { startedAt: '2026-10-24T10:00:00Z', step: 'downloading', bytes: 30 * 1048576, total: 120 * 1048576 } }));
  await host.tick();
  assert.match(host.root.innerHTML, /Downloading 30\.0 MB of about 120 MB · 25 %/, 'the host reports how far it has got (the total is an estimate)');
  assert.match(host.root.innerHTML, /<progress class="up-progress" max="125829120" value="31457280" aria-label="Download progress">/);
  host.get(() => ({ ...host.base, applying: { startedAt: '2026-10-24T10:00:00Z', step: 'downloading', bytes: 200 * 1048576, total: 120 * 1048576 } }));
  await host.tick();
  assert.match(host.root.innerHTML, /Downloading 120 MB of about 120 MB · 100 %/, 'never past the total');
  host.get(() => new Error('restarting'));
  await host.tick();
  assert.equal(step(host.root.innerHTML), 'Starting the new version', 'Epilykos is away');
  assert.match(host.root.innerHTML, /<li class="is-done">Downloading the new version<\/li>/);
  host.get(() => ({ ...host.base, applying: { startedAt: '2026-10-24T10:00:00Z', step: 'starting' } }));
  await host.tick();
  assert.equal(step(host.root.innerHTML), 'Checking it is healthy', 'answering, but the host waits for health');
  assert.doesNotMatch(host.root.innerHTML, /<progress/, 'no download bar once the download is over');
  host.get(() => ({ ...host.base, host: { supported: true, app: {} }, lastResult: { ok: true, toVersion: '3.0', finishedAt: '2026-10-24T10:05:00Z' } }));
  await host.tick();
  assert.doesNotMatch(host.root.innerHTML, /up-steps/);
  assert.match(host.root.innerHTML, /Updated .* to 3\.0/);
  console.log('ok - EpilykosOS app update: downloading → starting (away) → checking health → result');

  // Opened mid-update: it follows the host's step.
  const later = page('host');
  later.get(() => ({ ...later.base, applying: { startedAt: '2026-10-24T10:00:00Z', step: 'starting' } }));
  later.start(); await flush();
  assert.equal(step(later.root.innerHTML), 'Checking it is healthy');
  assert.ok(later.timers.length, 'and keeps following it');
  console.log('ok - opened during an update: shows the host\'s current step and follows it');

  // ── Docker: the download happens during the request ─────────────────
  const docker = page('docker');
  docker.get(() => docker.base);
  docker.start(); await flush();
  let finishPull;
  docker.post(new Promise(r => { finishPull = r; }));
  const clicked = docker.click({}, 'up-apply'); await flush();
  docker.timers.shift(); // the password box takes focus (50 ms)
  assert.equal(step(docker.root.innerHTML), 'Downloading the new version', 'while the pull runs');
  assert.match(docker.root.innerHTML, /aria-label="Working"/, 'nothing known yet: a moving bar');
  // The page asks how far the download has got while the Update request is open.
  docker.get(() => ({ ...docker.base, downloading: { startedAt: '2026-10-24T10:00:00Z', bytes: 12 * 1048576, total: 48 * 1048576 } }));
  await docker.tick();
  assert.match(docker.root.innerHTML, /Downloading 12\.0 MB of 48\.0 MB · 25 %/, 'Docker reports exact sizes: no "about"');
  assert.match(docker.root.innerHTML, /<progress class="up-progress" max="50331648" value="12582912"/);
  docker.get(() => ({ ...docker.base, downloading: { startedAt: '2026-10-24T10:00:00Z', bytes: 5, total: null } }));
  await docker.tick();
  assert.match(docker.root.innerHTML, /Downloading…/, 'a layer\'s size is not known yet: a moving bar');
  finishPull({ state: 'applying', toBuild: '2.1' }); await clicked; await flush();
  await docker.tick(); // the watcher wakes once more, sees the request is over and stops
  assert.equal(docker.timers.length, 1, 'only the wait for the restart is left');
  assert.equal(step(docker.root.innerHTML), 'Restarting Epilykos on it');
  docker.get(() => new Error('restarting'));
  await docker.tick();
  assert.equal(step(docker.root.innerHTML), 'Restarting Epilykos on it');
  docker.get(() => ({ ...docker.base, applying: { startedAt: '2026-10-24T10:00:00Z' } }));
  await docker.tick();
  assert.equal(step(docker.root.innerHTML), 'Checking it is healthy', 'back, the helper is finishing');
  docker.get(() => ({ ...docker.base, status: { state: 'up-to-date' }, lastResult: { ok: true, toBuild: '2.1', finishedAt: '2026-10-24T10:03:00Z' } }));
  await docker.tick();
  assert.doesNotMatch(docker.root.innerHTML, /up-steps/);
  console.log('ok - Docker app update: downloading (during the request) → restarting → checking health → result');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
