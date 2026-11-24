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
  const timers = [], intervals = [], listeners = {};
  let listener = null, getReply = null, postReply = null;
  const root = { innerHTML: '', addEventListener: (t, fn) => { if (t === 'click') listener = fn; }, contains: () => true, querySelectorAll: () => [] };
  const ctx = {
    document: { hidden: false, addEventListener: (t, fn) => { listeners[t] = fn; }, getElementById: id => (id === 'up-root' ? root : null),
      createElement: () => ({ innerHTML: '', querySelector: () => ({ value: 'pw', focus() {} }) }) },
    window: { stShell: { openDialog: async () => ({ value: 'ok' }), toast() {}, setNavBadge() {} } },
    JSON, String, Math, Date, Promise, isNaN, Number, Array, Object,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    fetch: async (url, opts) => {
      if (opts && opts.method === 'POST') {
        const r = await postReply;
        if (r instanceof Error) throw r;
        if (r && r.__status) return { ok: false, status: r.__status, json: async () => { throw new Error('not JSON'); } };   // a proxy's error page
        return { ok: true, json: async () => r };
      }
      const r = getReply();
      if (r instanceof Error) throw r;
      return { ok: true, json: async () => JSON.parse(JSON.stringify(r)) };
    },
  };
  const base = { installed: { version: '2.9.0', buildId: '1.1', channel: 'dev', builtAt: '2026-10-01T00:00:00Z' },
    windows: kind === 'windows' ? { status: { state: 'available', latest: { version: '3.0' } }, applying: null } : undefined,
    status: kind === 'docker' ? { state: 'available', latest: { version: '3.0', builtAt: '2026-10-20T00:00:00Z' } } : null,
    host: kind === 'host' ? { supported: true, app: { available: true, latest_version: '3.0' } } : null,
    method: { kind: kind === 'host' ? 'epilykos-os' : kind === 'windows' ? 'windows' : 'docker' }, auto: true, applying: null, lastResult: null, os: null };
  vm.createContext(ctx);
  return {
    root, timers, intervals, listeners, base,
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
  // ── Docker behind a proxy that ends the long Update request (Cloudflare: 524 after 100 s) ──
  for (const [name, cut] of [['a 524 from the proxy', { __status: 524 }], ['a dropped connection', new TypeError('Failed to fetch')]]) {
    const lost = page('docker');
    lost.get(() => lost.base);
    lost.start(); await flush();
    lost.post(Promise.resolve(cut));
    const click = lost.click({}, 'up-apply'); await flush();
    lost.timers.shift();
    await click; await flush();
    assert.equal(step(lost.root.innerHTML), 'Restarting Epilykos on it', name + ': not an error, the update is followed');
    assert.doesNotMatch(lost.root.innerHTML, /Request failed/, name);
    await lost.tick();   // the download watcher wakes once more and stops
    lost.get(() => ({ ...lost.base, applying: { startedAt: '2026-10-24T10:00:00Z' } }));
    await lost.tick();
    assert.equal(step(lost.root.innerHTML), 'Checking it is healthy', name + ': still installing');
    lost.get(() => ({ ...lost.base, status: { state: 'up-to-date' }, lastResult: { ok: true, toBuild: '2.1', finishedAt: '2026-10-24T10:03:00Z' } }));
    await lost.tick();
    assert.doesNotMatch(lost.root.innerHTML, /up-steps/, name + ': finished');
    assert.doesNotMatch(lost.root.innerHTML, /available/, name + ': no stale "update ready"');
  }
  console.log('ok - Docker app update: a proxy time-out or dropped connection on the Update request is followed to the end, not reported as a failure');
  // A refusal from Epilykos itself (wrong password) is still an error.
  const refused = page('docker');
  refused.get(() => refused.base);
  refused.start(); await flush();
  refused.post(Promise.resolve({ __status: 403 }));
  const c2 = refused.click({}, 'up-apply'); await flush(); refused.timers.shift(); await c2; await flush();
  assert.doesNotMatch(refused.root.innerHTML, /up-steps/, 'a 403 ends the install attempt');
  console.log('ok - a 403 is still treated as a failed attempt');
  // ── Windows: the old Epilykos still answers for a few seconds after the installer started ──
  const win = page('windows');
  win.get(() => win.base);
  win.start(); await flush();
  assert.match(win.root.innerHTML, /Update ready/);
  win.post(Promise.resolve({ state: 'applying' }));
  const wc = win.click({}, 'up-apply'); await flush();
  win.timers.shift();
  await wc; await flush();
  await win.tick();   // the download watcher stops
  await win.tick();   // first look, still the old process: not installing, same build
  assert.match(win.root.innerHTML, /up-steps|Installing/, 'still waiting: the old process answering is not "done"');
  assert.doesNotMatch(win.root.innerHTML, /Up to date/);
  win.get(() => new Error('restarting'));
  await win.tick();
  win.get(() => ({ ...win.base, installed: { ...win.base.installed, version: '3.0', buildId: '3.0' }, windows: { status: { state: 'up-to-date' }, applying: null } }));
  await win.tick();
  assert.match(win.root.innerHTML, /Up to date/, 'back on the new version: the status is refreshed');
  assert.doesNotMatch(win.root.innerHTML, /Update ready|up-steps/);
  console.log('ok - Windows update: the page waits for the restart, then shows the new status');

  // ── The page stays true while it is open: an update finished without a click here ──
  const idle = page('docker');
  idle.get(() => idle.base);
  idle.start(); await flush();
  assert.match(idle.root.innerHTML, /Update ready/);
  assert.equal(idle.intervals.length, 1, 'it looks again by itself');
  idle.get(() => ({ ...idle.base, installed: { ...idle.base.installed, version: '3.0', buildId: '3.0' }, status: { state: 'up-to-date' } }));
  await idle.intervals[0](); await flush();
  assert.match(idle.root.innerHTML, /Up to date|up-to-date/i, 'the new status shows without a reload');
  assert.doesNotMatch(idle.root.innerHTML, /Update ready/);
  idle.get(() => new Error('restarting'));
  await idle.listeners.visibilitychange(); await flush();   // away: no error shown, tries again later
  assert.doesNotMatch(idle.root.innerHTML, /Request failed|restarting/);
  console.log('ok - an open page picks up a finished update by itself, and when the tab comes back');
  // ── Only the numbers change: the page is not drawn again ───────────────
  // (Drawing it again every two seconds flickered, restarted the moving bar
  // and took the focus off Cancel.)
  const live = page('host');
  const dl = (bytes, total) => ({ ...live.base, applying: { startedAt: '2026-10-24T10:00:00Z', step: 'downloading', ...(total ? { bytes, total } : {}) } });
  live.get(() => dl(10 * 1048576, 100 * 1048576));
  live.start(); await flush();
  let html = live.root.innerHTML, writes = 0;
  Object.defineProperty(live.root, 'innerHTML', { get: () => html, set: v => { html = v; writes++; } });
  const el = () => { const a = {}; return { innerHTML: '', getAttribute: n => (n in a ? a[n] : null), setAttribute: (n, v) => { a[n] = v; }, removeAttribute: n => { delete a[n]; }, a }; };
  const text = el(), bar = el();
  live.root.querySelectorAll = sel => (sel === '.up-os-progress' ? [text] : sel === 'progress.up-progress' ? [bar] : []);
  live.get(() => dl(40 * 1048576, 100 * 1048576));
  await live.tick();
  assert.equal(writes, 0, 'new numbers do not redraw the page');
  assert.equal(text.innerHTML, 'Downloading 40.0 MB of about 100 MB · 40 %');
  assert.deepEqual(bar.a, { max: '104857600', value: '41943040', 'aria-label': 'Download progress' });
  live.get(() => dl(0, 0));   // the size is not known any more: back to a moving bar, still in place
  await live.tick();
  assert.equal(writes, 0);
  assert.equal(text.innerHTML, 'Downloading…');
  assert.deepEqual(bar.a, { 'aria-label': 'Working' }, 'max and value are taken off');
  live.get(() => ({ ...live.base, applying: { startedAt: '2026-10-24T10:00:00Z', step: 'starting' } }));
  await live.tick();
  assert.equal(writes, 1, 'a real change (the next step) draws the page again');
  // If the page was changed under it (the elements are not where they were), it redraws.
  const lost = page('host');
  lost.get(() => dl(10 * 1048576, 100 * 1048576));
  lost.start(); await flush();
  let html2 = lost.root.innerHTML, writes2 = 0;
  Object.defineProperty(lost.root, 'innerHTML', { get: () => html2, set: v => { html2 = v; writes2++; } });
  lost.get(() => dl(40 * 1048576, 100 * 1048576));
  await lost.tick();
  assert.equal(writes2, 1, 'no bar to update: the page is drawn again');
  console.log('ok - while only the progress changes, the bar and its text are updated in place');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
