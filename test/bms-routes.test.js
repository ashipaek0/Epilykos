'use strict';
const checks = require('./_checks');
/**
 * Bluetooth / wired BMS routes (routes/bms.js, mounted at /api): signed-in only, and the checks that run before a
 * Bluetooth adapter or serial port is touched answer with 400; device status and bank test work from stored data. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-bms-routes-'));
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
  app.use('/api', require('../routes/bms'));
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
  const routes = [['GET', '/api/bms/scan'], ['GET', '/api/bms/test'], ['GET', '/api/bluetooth/status'], ['GET', '/api/bluetooth/scan'],
    ['GET', '/api/bms-wired/fields/x'], ['POST', '/api/bms-wired/test'], ['POST', '/api/bms/bank/test'],
    ['GET', '/api/bms/device-metrics/x'], ['GET', '/api/bms/device-status?name=x']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    let r = await call('GET', '/api/bms/test');
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /MAC address required/);
    r = await call('POST', '/api/bms-wired/test', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Serial path required/);
    r = await call('POST', '/api/bms-wired/test', { serial_path: '/dev/ttyUSB9' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Profile required/);
    r = await call('POST', '/api/bms/bank/test', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Bank config/);
    assert.strictEqual((await call('GET', '/api/bms/device-metrics/' + 'n'.repeat(65))).status, 400);
    assert.strictEqual((await call('GET', '/api/bms/device-status')).status, 400);
    r = await call('GET', '/api/bms/device-status?name=Pack1');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { name: 'Pack1', connected: false, metricCount: 0, lastSeen: null });
    r = await call('GET', '/api/bms/device-metrics/Pack1');
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/api/bms/bank/test', { devices: [{ name: 'Pack1' }], functions: [] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.summary.devices_total, 1); assert.strictEqual(r.body.summary.devices_fresh, 0);
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/bms'\)\)/);
    assert.ok(!/app\.(get|post|use)\('\/api\/(bms|bluetooth)/.test(src));
  } finally { server.close(); }
  console.log('ok - BMS routes: signed-in only, bad requests answered before any hardware is touched, status and bank test from stored data');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
