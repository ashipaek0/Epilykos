'use strict';
const checks = require('./_checks');
/**
 * Metric management routes (routes/metricManagement.js, mounted at /api): signed-in only; list, create, delete one and delete
 * several, with the checks that answer 400 or 409 before anything is removed. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-metric-routes-'));
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
  app.use('/api', require('../routes/metricManagement'));
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
  const routes = [['GET', '/api/metrics/list'], ['POST', '/api/metrics/create'], ['DELETE', '/api/metrics/x'], ['POST', '/api/metrics/delete']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    let r = await call('POST', '/api/metrics/create', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Name required/);
    r = await call('POST', '/api/metrics/create', { name: 'test_metric_a', unit: 'W' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true);
    r = await call('POST', '/api/metrics/create', { name: 'test_metric_a', unit: 'W' });
    assert.strictEqual(r.status, 400, 'a duplicate is refused');
    r = await call('GET', '/api/metrics/list');
    assert.strictEqual(r.status, 200); assert.ok(JSON.stringify(r.body).includes('test_metric_a'), 'the new metric is listed');
    r = await call('POST', '/api/metrics/delete', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /list of metric names/);
    r = await call('POST', '/api/metrics/delete', { names: [] });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/metrics/delete', { names: [1] });
    assert.strictEqual(r.status, 400);
    r = await call('DELETE', '/api/metrics/test_metric_a');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true);
    r = await call('GET', '/api/metrics/list');
    assert.ok(!JSON.stringify(r.body).includes('test_metric_a'), 'the deleted metric is gone');
    await call('POST', '/api/metrics/create', { name: 'test_metric_b', unit: '' });
    r = await call('POST', '/api/metrics/delete', { names: ['test_metric_b'] });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true); assert.ok(Array.isArray(r.body.deleted));
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/metricManagement'\)\)/);
    assert.ok(!/app\.(get|post|delete)\('\/api\/metrics\/(list|create|delete|:name)/.test(src));
  } finally { server.close(); }
  console.log('ok - metric management routes: signed-in only, create, list and delete work, bad requests refused');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
