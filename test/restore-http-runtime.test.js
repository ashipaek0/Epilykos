'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const Database = require('better-sqlite3');

test('HTTP restore rebinds engines before confirmation, preserves session access and rolls back failed local health', { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-http-')), repo = path.resolve(__dirname, '..');
  for (const ent of fs.readdirSync(repo, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ['data', 'logs', 'test', 'docs'].includes(ent.name)) continue;
    const src = path.join(repo, ent.name), dst = path.join(root, ent.name);
    if (['modules', 'routes', 'services'].includes(ent.name)) fs.cpSync(src, dst, { recursive: true });
    else if (fs.statSync(src).isDirectory()) fs.symlinkSync(src, dst, 'dir');
    else fs.copyFileSync(src, dst);
  }
  function input(name, extra = {}) {
    const file = path.join(root, name + '.db'), db = new Database(file);
    db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric)); CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);`);
    for (const [k, v] of Object.entries({ restore_probe: name, setup_completed: 'true', ...extra })) db.prepare('INSERT INTO config VALUES(?,?)').run(k, v);
    db.close(); return file;
  }
  fs.mkdirSync(path.join(root, 'data'));
  fs.renameSync(input('original', { pvoutput_config: JSON.stringify({ enabled: true, api_key: 'fixture', system_id: '42', timezone: 'UTC' }), pvoutput_rate_limit_state: JSON.stringify({ general: { remaining: 0, limit: 60, resetAt: Math.floor(Date.now() / 1000) + 86400 } }) }), path.join(root, 'data/energy.db'));
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  let output = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SETTINGS_PASSWORD: 'fixture-password', SESSION_SECRET: 'fixture-session-secret', LOG_TO_FILE: 'false', ENC_KEY_FILE: path.join(root, 'key') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const base = 'http://127.0.0.1:' + port; let cookie;
  const request = (url, opts = {}) => fetch(base + url, { ...opts, headers: { 'x-requested-with': 'XMLHttpRequest', ...(cookie ? { cookie } : {}), ...opts.headers } });
  try {
    const deadline = Date.now() + 12000;
    while (true) {
      if (child.exitCode !== null) throw new Error('server exited: ' + output);
      try { if ((await request('/healthz')).ok) break; } catch (_) {}
      if (Date.now() >= deadline) throw new Error('server not ready: ' + output);
      await new Promise(r => setTimeout(r, 50));
    }
    const login = await request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }) });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await request('/api/pvoutput/status')).json()).enabled, true);
    async function restore(file) { const form = new FormData(); form.set('dbfile', new Blob([fs.readFileSync(file)]), 'input.db'); return request('/api/restore', { method: 'POST', body: form }); }
    let response = await restore(input('selected'));
    assert.equal(response.status, 200, await response.text());
    assert.equal((await (await request('/api/settings')).json()).restore_probe, 'selected');
    assert.equal((await (await request('/api/pvoutput/status')).json()).enabled, false);
    response = await restore(input('bad-local-health', { pvoutput_config: JSON.stringify({ enabled: true, api_key: 'fixture', system_id: '42', timezone: 'Invalid/Fixture' }), pvoutput_rate_limit_state: JSON.stringify({ general: { remaining: 0, limit: 60, resetAt: Math.floor(Date.now() / 1000) + 86400 } }) }));
    assert.equal(response.status, 500, await response.text());
    assert.equal((await (await request('/api/settings')).json()).restore_probe, 'selected');
    assert.equal((await request('/healthz')).status, 200);
    assert.equal(fs.existsSync(path.join(root, 'data/.restore-transaction.json')), false);
    assert.doesNotMatch(output, /Unhandled promise rejection|no such table: sessions/);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000).unref())]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
