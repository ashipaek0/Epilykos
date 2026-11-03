'use strict';
/**
 * test/websocket-limits.test.js — the live-state WebSocket (3 Nov 2026 audit).
 *
 * The state is public, but a web page opened on a computer that can reach the
 * dashboard could read it (browsers do not apply CORS to sockets), anyone could
 * hold unlimited connections open, and a client could send huge messages. Now:
 * a page may connect only from the site that served it, a client may send at
 * most 64 KB, an address may hold 30 connections, and dead connections are
 * dropped by a ping. Runs the real server.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const repo = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-ws-'));

const open = (port, headers = {}) => new Promise(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
  ws.on('message', () => resolve({ ok: true, ws }));   // the server sends the state first
  ws.on('unexpected-response', (req, res) => { res.resume(); resolve({ ok: false, status: res.statusCode }); });
  ws.on('error', () => resolve({ ok: false, status: 0 }));
  setTimeout(() => resolve({ ok: false, status: -1 }), 8000);
});

(async () => {
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(process.execPath, ['-e', `
    process.chdir(${JSON.stringify(dir)});
    const db = require(${JSON.stringify(path.join(repo, 'modules/database'))}); db.initializeDatabase(); db.setConfig('setup_wizard_completed', 'true');
    require(${JSON.stringify(path.join(repo, 'server.js'))});
  `], { env: { ...process.env, PORT: String(port), LOG_TO_FILE: 'false', ENC_KEY_FILE: path.join(dir, 'key'), SETTINGS_PASSWORD: 'pw-' + require('node:crypto').randomBytes(8).toString('hex'), SESSION_SECRET: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch (_) { /* starting */ }
    if (Date.now() > deadline) throw new Error('server did not start: ' + output);
    await new Promise(r => setTimeout(r, 150));
  }
  const sockets = [];
  try {
    // ── Origin ───────────────────────────────────────────────────────────
    let r = await open(port, { Origin: 'https://evil.example' });
    assert.equal(r.ok, false); assert.equal(r.status, 403, 'a page from another site cannot read the live state');
    r = await open(port, { Origin: `http://127.0.0.1:${port}` });
    assert.equal(r.ok, true, 'the dashboard\'s own page can'); sockets.push(r.ws);
    r = await open(port);
    assert.equal(r.ok, true, 'and a client that is not a browser (no Origin) can'); sockets.push(r.ws);
    r = await open(port, { Origin: 'http://evil.example', Host: `127.0.0.1:${port}` });
    assert.equal(r.status, 403);
    // A trusted proxy (loopback here) reports the host the browser used.
    r = await open(port, { Origin: 'https://box.example', 'X-Forwarded-Host': 'box.example' });
    assert.equal(r.ok, true, 'behind a trusted proxy that rewrites Host, the forwarded host is the one that counts'); sockets.push(r.ws);
    r = await open(port, { Origin: 'https://evil.example', 'X-Forwarded-Host': 'box.example' });
    assert.equal(r.status, 403);
    console.log('ok - only the site that served the page may open the socket');

    // ── Message size ─────────────────────────────────────────────────────
    // Just over the limit, so the whole frame is on the wire before the server answers: the server's own
    // close (1009, message too big) is what the client sees. (A multi-megabyte send can instead meet a
    // dropped connection, which a client reports as 1006, depending on timing.)
    const big = sockets[0];
    const closed = new Promise(res => big.once('close', code => res(code)));
    big.send(Buffer.alloc(80 * 1024, 65));
    assert.equal(await closed, 1009, 'an 80 KB message closes the connection (limit 64 KB)');
    // And a huge one is refused too, whichever way the client sees the connection end.
    const huge = await open(port); assert.equal(huge.ok, true);
    const hugeClosed = new Promise(res => huge.ws.once('close', code => res(code)));
    huge.ws.on('error', () => {});
    huge.ws.send(Buffer.alloc(8 * 1024 * 1024, 65));
    assert.ok([1009, 1006].includes(await hugeClosed), 'an 8 MB message ends the connection');
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).ok, true, 'and the server carries on');
    console.log('ok - a client cannot send more than 64 KB');

    // ── Connections per address ──────────────────────────────────────────
    for (const ws of sockets) { try { ws.terminate(); } catch (_) { /* gone */ } }
    sockets.length = 0;
    await new Promise(r => setTimeout(r, 300));
    const results = [];
    for (let i = 0; i < 34; i++) { const o = await open(port); results.push(o); if (o.ok) sockets.push(o.ws); }
    const accepted = results.filter(o => o.ok).length;
    assert.equal(accepted, 30, 'an address holds 30 connections');
    assert.ok(results.filter(o => !o.ok).every(o => o.status === 429), 'the rest are told to wait');
    // A closed connection frees its place.
    sockets[0].close(); await new Promise(r => setTimeout(r, 400)); sockets.shift();
    const again = await open(port);
    assert.equal(again.ok, true, 'a place frees up when a connection closes'); sockets.push(again.ws);
    console.log('ok - 30 connections per address, freed when they close');
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch (_) { /* gone */ } }
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 4000); });
  }

  // Dead connections are dropped by a ping.
  const src = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
  assert.match(src, /ws\.on\('pong'/);
  assert.match(src, /if \(ws\.isAlive === false\) \{ ws\.terminate\(\)/);
  assert.match(src, /clearInterval\(wsPingTimer\)/, 'the ping stops with the server');
  console.log('ok - a connection that stops answering pings is dropped');

  fs.rmSync(dir, { recursive: true, force: true });
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
