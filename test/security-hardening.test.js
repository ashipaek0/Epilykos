'use strict';
/**
 * test/security-hardening.test.js — the rest of the 3 Nov 2026 audit fixes.
 *
 *  - PVOutput's public alert callback needs its token; Settings makes it, it is
 *    stored encrypted and survives saving the form; stored alerts are capped
 *  - secrets are hidden in every log transport, and in the alert address
 *  - Permissions-Policy, HSTS over HTTPS only, no X-Powered-By
 *  - an uncaught exception stops the server cleanly with exit code 1
 *  - uploads go to a folder only this process can read
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const crypto = require('node:crypto');
const repo = path.join(__dirname, '..');
// Every credential-shaped value is made fresh for the run, so none is written in the file.
const random = (prefix, bytes = 12) => prefix + crypto.randomBytes(bytes).toString('hex');
const read = p => fs.readFileSync(path.join(repo, p), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-hard-'));
process.chdir(dir);
process.env.LOG_TO_FILE = 'false';
process.env.ENC_KEY_FILE = path.join(dir, 'key');

(async () => {
  // ── PVOutput alert callback ──────────────────────────────────────────
  const db = require('../modules/database');
  db.initializeDatabase();
  const pv = require('../modules/pvoutput');
  const TOKEN = crypto.randomBytes(12).toString('hex');
  const setPv = cfg => db.setConfig('pvoutput_config', JSON.stringify(cfg));
  const base = { enabled: true, system_id: '12345', api_key: random('pvk-') };

  const { createRouter, MAX_ALERTS } = require('../modules/pvoutput/webhook');
  const express = require('express');
  const serve = () => new Promise(res => {
    const app = express(); app.use(express.json());
    app.use('/hook', createRouter({ prepare: sql => db.getDb().prepare(sql) }, db.getConfig));
    const s = http.createServer(app).listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}/hook` }));
  });
  const post = (url, form) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }).then(r => r.status);
  const count = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM pvoutput_alerts').get().n;

  let { s, url } = await serve();
  setPv(base);                                                    // enabled, but no token yet
  assert.equal(await post(url, { sid: '12345', type: '1', message: 'x' }), 403, 'no token configured: shut');
  assert.equal(await post(url + '/anything', { sid: '12345', type: '1' }), 403);
  assert.equal(count(), 0);
  setPv({ ...base, webhook_token: TOKEN });
  assert.equal(await post(url, { sid: '12345', type: '1' }), 403, 'the right system id alone is not enough any more');
  assert.equal(await post(url + '/wrong-token-wrong-token-1234', { sid: '12345', type: '1' }), 403);
  assert.equal(await post(url + '/' + TOKEN, { sid: '99999', type: '1' }), 403, 'wrong system id');
  assert.equal(await post(url + '/' + TOKEN, { sid: '12345', type: '2', message: 'low output' }), 200, 'the token as a path segment');
  assert.equal(await post(url + '?token=' + TOKEN, { sid: '12345', type: '3' }), 200, 'or as ?token=');
  assert.equal(count(), 2);
  s.close();
  console.log('ok - the PVOutput alert callback is shut without its token');

  // Only the newest alerts are kept.
  ({ s, url } = await serve());
  const insert = db.getDb().prepare("INSERT INTO pvoutput_alerts (system_id, alert_type, message, received_at) VALUES ('12345', 1, 'old', datetime('now'))");
  for (let i = 0; i < MAX_ALERTS + 100; i++) insert.run();
  assert.equal(await post(url + '/' + TOKEN, { sid: '12345', type: '9', message: 'newest' }), 200);
  assert.equal(count(), MAX_ALERTS, `capped at ${MAX_ALERTS}`);
  assert.equal(db.getDb().prepare('SELECT message FROM pvoutput_alerts ORDER BY id DESC LIMIT 1').get().message, 'newest', 'the newest is kept');
  s.close();
  console.log('ok - only the newest alerts are kept');

  // The token is made on request, stored encrypted, and survives saving the form.
  setPv(base);
  const kept = JSON.parse(pv.keepWebhookToken(JSON.stringify({ ...base, system_id: '777' })));
  assert.equal(kept.webhook_token, undefined, 'nothing to keep yet');
  const router = pv.router;
  const handle = (method, p) => router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]).route.stack[0].handle;
  const call = async (method, p) => { let data; await handle(method, p)({}, { json(d) { data = d; return this; }, status() { return this; } }); return data; };
  const first = (await call('get', '/webhook-address')).path;
  assert.match(first, /^\/api\/pvoutput\/webhook\/[a-f0-9]{48}$/);
  assert.equal((await call('get', '/webhook-address')).path, first, 'the same address each time');
  const raw = db.getDb().prepare("SELECT value FROM config WHERE key = 'pvoutput_config'").get().value;
  assert.ok(!raw.includes(first.split('/').pop()), 'the token is not stored in clear');
  assert.match(raw, /\$enc1\$/);
  const token = first.split('/').pop();
  const SENT = random('sent-');
  const saved = JSON.parse(pv.keepWebhookToken(JSON.stringify({ ...base, system_id: '777' })));
  assert.equal(saved.webhook_token, token, 'saving the form (which has no token) keeps the stored one');
  assert.equal(saved.system_id, '777');
  assert.equal(JSON.parse(pv.keepWebhookToken(JSON.stringify({ ...base, webhook_token: SENT }))).webhook_token, SENT, 'one that is sent is not replaced');
  assert.equal(pv.keepWebhookToken('not json'), 'not json');
  const rotated = (await call('post', '/webhook-address/new')).path;
  assert.notEqual(rotated, first, 'a new address replaces it');
  console.log('ok - the token is made in Settings, encrypted, kept when the form is saved, and can be replaced');
  // The management routes must not sit under the public callback's path (it would answer them).
  assert.ok(!router.stack.some(l => l.route && /^\/webhook\//.test(l.route.path)), 'no management route under /webhook/');
  assert.match(read('modules/csrfProtection.js'), /webhook\(\?:\\\/\[\^\/\]\+\)\?/, 'the CSRF exemption is only the callback itself');

  // The page shows it masked and does not save it with the form.
  assert.match(read('public/settings.html'), /<input type="password" id="pvoutput-webhook-url"[^>]*readonly/);
  assert.doesNotMatch(read('public/settings.js'), /webhook_url: document\.getElementById/);
  assert.doesNotMatch(read('public/js/setup.js'), /field\('Webhook URL'/);
  console.log('ok - the address is shown masked, read-only, and not saved with the form');

  // ── Logs ─────────────────────────────────────────────────────────────
  const logBuffer = require('../modules/logBuffer');
  logBuffer.setSecretValues([]);
  assert.equal(logBuffer.redact('POST /api/pvoutput/webhook/' + TOKEN + ' 403'), 'POST /api/pvoutput/webhook/[hidden] 403');
  assert.equal(logBuffer.redact('POST /api/pvoutput/webhook/' + TOKEN + '?x=1'), 'POST /api/pvoutput/webhook/[hidden]?x=1');
  const logDir = path.join(dir, 'logs');
  const CONFIGURED = random('cfg-'), BEARER = random('', 10);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `
      const { logger } = require(${JSON.stringify(path.join(repo, 'modules/logger'))});
      require(${JSON.stringify(path.join(repo, 'modules/logBuffer'))}).setSecretValues([${JSON.stringify(CONFIGURED)}]);
      logger.info('connecting with ${CONFIGURED} and Bearer ${BEARER}');
      logger.warn('request', { url: '/api/pvoutput/webhook/${TOKEN}', note: '${CONFIGURED}' });
      setTimeout(() => process.exit(0), 3000);
    `], { env: { ...process.env, LOG_TO_FILE: 'true', LOG_DIR: logDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    child.on('exit', () => resolve(text)); child.on('error', reject);
  });
  // The log file is written a moment after the line is logged; a slow machine may need longer.
  const readLogs = () => { try { return fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n'); } catch (_) { return ''; } };
  let fileText = readLogs();
  for (let i = 0; i < 40 && !fileText.includes('connecting with'); i++) { await new Promise(r => setTimeout(r, 250)); fileText = readLogs(); }
  for (const [where, text] of [['the console', out], ['the log file', fileText]]) {
    assert.ok(text.includes('connecting with'), `${where} has the line`);
    assert.ok(!text.includes(CONFIGURED), `${where} hides a configured secret`);
    assert.ok(!text.includes(BEARER), `${where} hides a bearer token`);
    assert.ok(!text.includes(TOKEN), `${where} hides the alert token in a path`);
  }
  console.log('ok - secrets are hidden in the console and the log file, not only in Settings → Logs');

  // ── Headers ──────────────────────────────────────────────────────────
  const mw = require('../modules/securityHeaders').middleware();
  const run = secure => { const h = {}; mw({ secure }, { setHeader: (k, v) => { h[k] = v; } }, () => {}); return h; };
  assert.match(run(false)["Permissions-Policy"], /geolocation=\(self\).*camera=\(\).*microphone=\(\)/);
  // Chrome warns in the console about every name it does not know (it did for bluetooth).
  const KNOWN = ['geolocation', 'camera', 'microphone', 'payment', 'usb'];
  for (const part of run(false)['Permissions-Policy'].split(',')) assert.ok(KNOWN.includes(part.trim().split('=')[0]), `known Permissions-Policy feature: ${part}`);
  assert.equal(run(false)['Strict-Transport-Security'], undefined, 'no HSTS over plain HTTP');
  assert.equal(run(true)['Strict-Transport-Security'], 'max-age=15552000', 'HSTS over HTTPS, without includeSubDomains');
  const server = read('server.js');
  assert.match(server, /app\.disable\('x-powered-by'\)/);
  console.log('ok - Permissions-Policy, HSTS only over HTTPS, no X-Powered-By');

  // ── Uploads and the BLE helper ───────────────────────────────────────
  assert.match(server, /const uploadDir = fs\.mkdtempSync\(path\.join\(require\('os'\)\.tmpdir\(\), 'epilykos-uploads-'\)\)/);
  assert.match(server, /dest: uploadDir,/);
  assert.match(server, /const root = path\.resolve\(uploadDir\);/);
  assert.match(read('modules/ble.js'), /child\.stdin\.on\('error'/);
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-uploads-'));
  assert.equal(fs.statSync(probe).mode & 0o077, 0, 'mkdtemp makes the folder readable by this process only');
  fs.rmdirSync(probe);
  console.log('ok - uploads go to a private folder; the BLE helper\'s stdin errors are handled');

  // ── An uncaught exception stops the server cleanly, with exit code 1 ──
  const port = await new Promise(res => { const l = net.createServer(); l.listen(0, '127.0.0.1', () => { const p = l.address().port; l.close(() => res(p)); }); });
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-crash-'));
  const child = spawn(process.execPath, ['-e', `
    process.chdir(${JSON.stringify(crashDir)});
    const d = require(${JSON.stringify(path.join(repo, 'modules/database'))}); d.initializeDatabase(); d.setConfig('setup_wizard_completed', 'true');
    require(${JSON.stringify(path.join(repo, 'server.js'))});
    setTimeout(() => { throw new Error('boom from the audit test'); }, 2500);
  `], { env: { ...process.env, PORT: String(port), LOG_TO_FILE: 'false', ENC_KEY_FILE: path.join(crashDir, 'key'), SETTINGS_PASSWORD: random('pw-'), SESSION_SECRET: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let crashOut = ''; child.stdout.on('data', b => { crashOut += b; }); child.stderr.on('data', b => { crashOut += b; });
  const exit = await new Promise(res => { child.once('exit', (code, signal) => res({ code, signal })); setTimeout(() => { child.kill('SIGKILL'); }, 20000); });
  assert.equal(exit.code, 1, `exit code 1 after an uncaught exception (got ${exit.code} ${exit.signal || ''})`);
  assert.match(crashOut, /Uncaught exception: Error: boom from the audit test/);
  assert.match(crashOut, /Shutdown complete/, 'it shut down cleanly first');
  fs.rmSync(crashDir, { recursive: true, force: true });
  console.log('ok - an uncaught exception shuts the server down cleanly with exit code 1');

  db.getDb().close();
  process.chdir(os.tmpdir());
  fs.rmSync(dir, { recursive: true, force: true });
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
