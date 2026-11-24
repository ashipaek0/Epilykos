'use strict';
const checks = require('./_checks');
/**
 * Dongle routes (routes/dongle.js, mounted at /api): signed-in only; the profile list, one profile and its
 * entity catalog, the status list, and the test connection's checks (host, port, SSRF guard) that answer before
 * anything is dialled.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-dongle-routes-'));
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
  app.use('/api', require('../routes/dongle'));
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
  const routes = [['GET', '/api/dongle/profiles'], ['GET', '/api/dongle/profile/luxpower-geta'], ['GET', '/api/dongle/profile/luxpower-geta/entities'],
    ['POST', '/api/dongle/test'], ['GET', '/api/dongle/status']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    let r = await call('GET', '/api/dongle/profiles');
    assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.body) && r.body.length > 0 && r.body.every(p => p.id));
    const id = r.body[0].id;
    r = await call('GET', '/api/dongle/profile/' + id);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('GET', '/api/dongle/profile/' + id + '/entities')).status, 200);
    assert.strictEqual((await call('GET', '/api/dongle/profile/..%2F..%2Fpackage')).status, 404);
    r = await call('GET', '/api/dongle/status');
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, []);
    r = await call('POST', '/api/dongle/test', { profile: 'no-such-profile', transport: 'ble-gatt' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Profile not found/);
    const base = { profile: id, transport: 'modbus-tcp' };
    r = await call('POST', '/api/dongle/test', { ...base, host: '127.0.0.1', port: 502 });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /not allowed/);
    r = await call('POST', '/api/dongle/test', { ...base, host: 'localhost', port: 502 });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/dongle/test', { ...base, host: '169.254.169.254', port: 502 });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/dongle/test', { ...base, host: '192.168.1.5', port: 99999 });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Invalid port/);
    r = await call('POST', '/api/dongle/test', { ...base });
    assert.strictEqual(r.status, 400);
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/dongle'\)\)/);
    assert.ok(!/app\.(get|post|use)\('\/api\/dongle/.test(src));
  } finally { server.close(); }
  console.log('ok - dongle routes: signed-in only, profiles served, unsafe test targets refused before any dial');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
