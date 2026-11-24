'use strict';
const checks = require('./_checks');
/**
 * Tuya helper routes (routes/tuya.js, mounted at /api): every route needs a
 * signed-in session, and the checks that run before a device or the cloud is
 * contacted answer with 400 (a directed scan only reaches private networks).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-tuya-routes-'));
process.chdir(tmp);
process.env.SETTINGS_PASSWORD = 'made-up-test-password';
require('../modules/database').initializeDatabase();
const express = require('express');
const session = require('express-session');

(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false, cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax' } }));
  app.get('/signin', (q, s) => { q.session.authenticated = true; s.send('ok'); });
  app.use('/api', require('../routes/tuya'));
  app.use('/api', (q, s) => s.status(404).json({ error: 'Not found' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let cookie = '';
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let t = ''; res.on('data', c => { t += c; });
      res.on('end', () => { if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; let j = null; try { j = JSON.parse(t); } catch { /* empty */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const routes = [['GET', '/api/tuya-discover'], ['POST', '/api/tuya-cloud-fetch'], ['POST', '/api/tuya-generate-qr'], ['POST', '/api/tuya-poll-login'],
    ['POST', '/api/tuya-fetch-oauth'], ['POST', '/api/test-tuya'], ['POST', '/api/tuya-verify-all']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    let r = await call('GET', '/api/tuya-discover?subnet=not-a-cidr');
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Invalid subnet/);
    r = await call('GET', '/api/tuya-discover?subnet=8.8.8.0/24');
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /private RFC1918/);
    r = await call('GET', '/api/tuya-discover?subnet=300.1.1.0/24');
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await call('POST', '/api/tuya-generate-qr', {})).status, 400);
    assert.strictEqual((await call('POST', '/api/tuya-poll-login', { uid: 'x' })).status, 400);
    assert.strictEqual((await call('POST', '/api/tuya-fetch-oauth', {})).status, 400);
    assert.strictEqual((await call('POST', '/api/tuya-verify-all', { devices: [] })).status, 400);
    assert.strictEqual((await call('POST', '/api/tuya-verify-all', {})).status, 400);
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/tuya'\)\)/);
    assert.ok(!/app\.(get|post)\('\/api\/(tuya-|test-tuya)/.test(src));
  } finally { server.close(); }
  console.log('ok - Tuya routes: signed-in only, bad requests answered before anything is contacted');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
