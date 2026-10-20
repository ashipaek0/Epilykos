'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const Database = require('better-sqlite3');
const { pipeline } = require('node:stream/promises');
const { createGzip } = require('node:zlib');

test('authenticated HTTP large restores, cancellation, restart status and independent JSON limits', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-upload-http-')), repo = path.resolve(__dirname, '..');
  for (const ent of fs.readdirSync(repo, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ['data', 'logs', 'test', 'docs'].includes(ent.name)) continue;
    const src = path.join(repo, ent.name), dst = path.join(root, ent.name);
    if (['modules', 'routes', 'services'].includes(ent.name)) fs.cpSync(src, dst, { recursive: true });
    else if (fs.statSync(src).isDirectory()) fs.symlinkSync(src, dst, 'dir'); else fs.copyFileSync(src, dst);
  }
  function fixture(name, large) {
    const file = path.join(root, name + '.db'), db = new Database(file);
    db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric)); CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);`);
    db.prepare('INSERT INTO config VALUES(?,?)').run('setup_completed', 'true'); db.prepare('INSERT INTO config VALUES(?,?)').run('upload_probe', name);
    if (large) db.exec('CREATE TABLE opaque(payload BLOB); INSERT INTO opaque VALUES(zeroblob(55000000))');
    db.close(); return file;
  }
  fs.mkdirSync(path.join(root, 'data')); fs.renameSync(fixture('original'), path.join(root, 'data/energy.db'));
  const input = fixture('selected', true), bytes = fs.statSync(input).size;
  assert.ok(bytes > 50 * 1024 * 1024);
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = 'http://127.0.0.1:' + port; let child, output = '', cookie, csrf;
  const request = (url, opts = {}) => fetch(base + url, { ...opts, headers: { 'x-requested-with': 'XMLHttpRequest', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(cookie ? { cookie } : {}), ...opts.headers } });
  const post = (url, body) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SETTINGS_PASSWORD: 'fixture-password', SESSION_SECRET: 'fixture-session', LOG_TO_FILE: 'false', ENC_KEY_FILE: path.join(root, 'key') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const deadline = Date.now() + 12000;
    for (;;) { if (child.exitCode !== null) throw new Error(output); try { if ((await request('/healthz')).ok) break; } catch (_) {} if (Date.now() > deadline) throw new Error(output); await new Promise(r => setTimeout(r, 30)); }
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill(signal);
    const force = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(force);
  }
  async function create(size = bytes) {
    const response = await post('/api/restore-jobs', { bytes: size, name: 'input.db' }); assert.equal(response.status, 201, await response.clone().text()); return response.json();
  }
  function chunk(job, start, length, file = input) {
    return request('/api/restore-jobs/' + job.id + '/chunks', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-restore-offset': String(start), 'content-length': String(length) }, body: fs.createReadStream(file, { start, end: start + length - 1 }), duplex: 'half' });
  }
  async function wait(job) {
    const deadline = Date.now() + 20000;
    for (;;) { const response = await request('/api/restore-jobs/' + job.id); assert.equal(response.status, 200); const status = await response.json(); if (!['uploading', 'preparing', 'activating', 'recovering'].includes(status.phase)) return status; if (Date.now() > deadline) throw new Error('restore did not finish: ' + JSON.stringify(status)); await new Promise(r => setTimeout(r, 30)); }
  }
  try {
    await start();
    const bootstrap = await request('/api/csrf-token'); cookie = bootstrap.headers.get('set-cookie').split(';')[0]; csrf = (await bootstrap.json()).token;
    assert.equal((await post('/api/restore-jobs', { bytes })).status, 401);
    const login = await post('/api/login', { password: 'fixture-password' }); assert.equal(login.status, 200); if (login.headers.get('set-cookie')) cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/restore-jobs', { method: 'POST', headers: { origin: 'https://invalid.fixture', 'content-type': 'application/json' }, body: JSON.stringify({ bytes }) })).status, 403);
    await t.test('bad declaration and JSON envelope stay bounded', async () => {
      assert.equal((await post('/api/restore-jobs', { bytes: null })).status, 400);
      assert.equal((await post('/api/restore-jobs', { bytes, oversized: 'x'.repeat(150000) })).status, 413);
    });
    let job = await create();
    assert.equal((await chunk(job, 1, job.chunkBytes)).status, 409);
    const first = await chunk(job, 0, job.chunkBytes); assert.equal(first.status, 200);
    assert.equal((await first.json()).received, job.chunkBytes);
    assert.equal((await post('/api/restore-jobs/' + job.id + '/cancel')).status, 200);
    assert.equal((await wait(job)).phase, 'cancelled');
    job = await create(); assert.equal((await chunk(job, 0, job.chunkBytes)).status, 200);
    await stop('SIGKILL'); await start();
    assert.equal((await wait(job)).phase, 'failed');
    assert.equal((await (await request('/api/settings')).json()).upload_probe, 'original');
    job = await create();
    let offset = 0;
    while (offset < bytes) { const length = Math.min(job.chunkBytes, bytes - offset); const response = await chunk(job, offset, length); assert.equal(response.status, offset + length === bytes ? 202 : 200, await response.clone().text()); offset += length; }
    assert.equal((await wait(job)).phase, 'selected');
    assert.equal((await (await request('/api/settings')).json()).upload_probe, 'selected');
    await stop(); await start();
    assert.equal((await wait(job)).phase, 'selected');
    assert.equal((await (await request('/api/settings')).json()).upload_probe, 'selected');
    await t.test('magic-detected gzip upload keeps native restore and owner session access', async () => {
      const archive = path.join(root, 'compressed.bin');
      await pipeline(fs.createReadStream(input), createGzip(), fs.createWriteStream(archive));
      const size = fs.statSync(archive).size; assert.ok(size < 4 * 1024 * 1024);
      const compressed = await create(size); assert.equal((await chunk(compressed, 0, size, archive)).status, 202);
      assert.equal((await wait(compressed)).phase, 'selected');
      assert.equal((await (await request('/api/settings')).json()).upload_probe, 'selected');
    });
    await t.test('JSON layout import keeps its separate 50MiB multipart limit', async () => {
      const boundary = 'epilykos-fixture-boundary';
      async function* body() { yield Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="layout"; filename="layout.json"\r\nContent-Type: application/json\r\n\r\n'); for await (const bytes of fs.createReadStream(input)) yield bytes; yield Buffer.from('\r\n--' + boundary + '--\r\n'); }
      const response = await request('/api/dashboard-config/import', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }, body: Readable.from(body()), duplex: 'half' });
      assert.equal(response.ok, false); assert.match(output, /File too large/);
    });
    assert.doesNotMatch(output, /Unhandled promise rejection|no such table: sessions/);
  } finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
