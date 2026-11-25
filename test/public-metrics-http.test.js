'use strict';
const checks = require('./_checks');
/**
 * The real server, a visitor and a signed-in session, with "Share every reading without signing in" off and then on: the metric
 * endpoints, the dashboard state and the live socket give a visitor only the readings the public dashboards use while it is off,
 * and a signed-in session everything. A new install starts with sharing off.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const WebSocket = require('ws');

const repo = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-public-metrics-'));

(async () => {
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = 'http://127.0.0.1:' + port;
  let output = '';
  const child = spawn(process.execPath, [path.join(repo, 'server.js')], { cwd: tmp, env: { ...process.env, PORT: String(port), SETTINGS_PASSWORD: 'fixture-password-1', SESSION_SECRET: 'fixture-session', LOG_TO_FILE: 'false', ENC_KEY_FILE: path.join(tmp, 'key') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const stop = async () => { if (child.exitCode !== null) return; const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 4000); await exited; clearTimeout(force); };

  let cookie = '', csrf = '';
  const visitor = (url) => fetch(base + url);
  const signedIn = (url, opts = {}) => fetch(base + url, { ...opts, headers: { 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': csrf, cookie, ...(opts.headers || {}) } });
  const post = (url, body) => signedIn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const firstMessage = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no message from the socket')); }, 8000);
    ws.on('message', m => { clearTimeout(timer); ws.close(); resolve(JSON.parse(String(m))); });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });

  try {
    const deadline = Date.now() + 40000;
    for (;;) { if (child.exitCode !== null) throw new Error('server exited: ' + output); try { if ((await visitor('/healthz')).ok) break; } catch (_) { /* not up yet */ } if (Date.now() > deadline) throw new Error('server did not start: ' + output); await new Promise(r => setTimeout(r, 100)); }

    const boot = await visitor('/api/csrf-token'); cookie = boot.headers.get('set-cookie').split(';')[0]; csrf = (await boot.json()).token;
    const login = await post('/api/login', { password: 'fixture-password-1' }); assert.strictEqual(login.status, 200);
    if (login.headers.get('set-cookie')) cookie = login.headers.get('set-cookie').split(';')[0];
    if (login.headers.get('x-csrf-token')) csrf = login.headers.get('x-csrf-token');

    // A new install starts with sharing off.
    let settings = await (await signedIn('/api/settings')).json();
    assert.strictEqual(settings.public_share_all_metrics, 'false', 'a new install starts with sharing off');

    // Readings: one on the public dashboard, the role metric, one only on a hidden dashboard, and one on none.
    assert.strictEqual((await post('/api/settings', { role_metrics: JSON.stringify({ solar: 'pv_power' }) })).status, 200);
    const dashboards = { activeDashboard: 'main', dashboards: [
      { id: 'main', name: 'Main', layout: [{ id: 'b1', type: 'metric-trend', gridX: 0, gridY: 0, gridW: 4, gridH: 2, config: { metric: 'shown_metric' } }] },
      { id: 'hidden', name: 'Hidden', layout: [{ id: 'b2', type: 'metric-trend', gridX: 0, gridY: 0, gridW: 4, gridH: 2, config: { metric: 'hidden_dashboard_metric' } }] }] };
    assert.strictEqual((await post('/api/dashboard-config', dashboards)).status, 200);
    const db = new Database(path.join(tmp, 'data', 'energy.db'));
    const now = Math.floor(Date.now() / 1000);
    for (const name of ['pv_power', 'shown_metric', 'hidden_dashboard_metric', 'fridge_power']) {
      db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run(name, 42, now, 'W');
      db.prepare('INSERT OR REPLACE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)').run(now - 60, name, 41);
    }
    db.close();
    const hidden = ['hidden_dashboard_metric', 'fridge_power'], shown = ['pv_power', 'shown_metric'];
    const wait = () => new Promise(r => setTimeout(r, 2300));   // the allowed readings are kept for two seconds
    await wait();

    // ── Sharing off ──
    const checkVisitor = async (label) => {
      const current = await (await visitor('/api/metrics/current')).json();
      for (const n of shown) assert.ok(n in current, `${label}: a visitor reads ${n}`);
      for (const n of hidden) assert.ok(!(n in current), `${label}: a visitor does not read ${n}`);
      const names = await (await visitor('/api/metrics/names')).json();
      assert.ok(shown.every(n => names.includes(n)) && hidden.every(n => !names.includes(n)), `${label}: the names a visitor gets`);
      for (const n of shown) assert.strictEqual((await visitor(`/api/metrics/history?metric=${n}&hours=24`)).status, 200, `${label}: history of ${n}`);
      for (const n of hidden) { const r = await visitor(`/api/metrics/history?metric=${n}&hours=24`); assert.strictEqual(r.status, 403, `${label}: history of ${n}`); assert.match((await r.json()).error, /Sign in/); }
      const state = await (await visitor('/api/dashboard-state')).json();
      assert.ok(shown.every(n => n in state.metrics) && hidden.every(n => !(n in state.metrics)), `${label}: the dashboard state a visitor gets`);
      assert.ok(state.current && state.savings, `${label}: the overview is whole`);
      const pushed = await firstMessage({});
      assert.strictEqual(pushed.type, 'dashboard-state');
      assert.ok(shown.every(n => n in pushed.data.metrics) && hidden.every(n => !(n in pushed.data.metrics)), `${label}: the socket a visitor opens`);
      assert.ok(!JSON.stringify(pushed).includes('fridge_power'), `${label}: nothing of a hidden reading in what a visitor is pushed`);
    };
    await checkVisitor('sharing off');
    console.log('ok - sharing off: a visitor gets only the public dashboards\' readings, over HTTP and the socket');

    // A signed-in session sees everything, on every route.
    const all = await (await signedIn('/api/metrics/current')).json();
    for (const n of [...shown, ...hidden]) assert.ok(n in all, `signed in reads ${n}`);
    for (const n of hidden) assert.strictEqual((await signedIn(`/api/metrics/history?metric=${n}&hours=24`)).status, 200);
    const stateIn = await (await signedIn('/api/dashboard-state')).json();
    assert.ok([...shown, ...hidden].every(n => n in stateIn.metrics), 'signed in: the whole state');
    const pushedIn = await firstMessage({ cookie });
    assert.ok([...shown, ...hidden].every(n => n in pushedIn.data.metrics), 'signed in: the socket carries every reading');
    console.log('ok - signed in: every reading, over HTTP and the socket');

    // ── Sharing on ──
    assert.strictEqual((await post('/api/settings/dashboard', { public_share_all_metrics: 'true' })).status, 200);
    const on = await (await visitor('/api/metrics/current')).json();
    for (const n of [...shown, ...hidden]) assert.ok(n in on, `sharing on: a visitor reads ${n}`);
    assert.strictEqual((await visitor('/api/metrics/history?metric=fridge_power&hours=24')).status, 200);
    const stateOn = await (await visitor('/api/dashboard-state')).json();
    assert.ok([...shown, ...hidden].every(n => n in stateOn.metrics), 'sharing on: the state');
    const pushedOn = await firstMessage({});
    assert.ok([...shown, ...hidden].every(n => n in pushedOn.data.metrics), 'sharing on: the socket');
    console.log('ok - sharing on: a visitor reads every reading, as before');

    // And off again.
    assert.strictEqual((await post('/api/settings/dashboard', { public_share_all_metrics: 'false' })).status, 200);
    await checkVisitor('off again');
    console.log('ok - turning sharing off again closes it');
  } finally { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
