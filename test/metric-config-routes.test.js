'use strict';
const checks = require('./_checks');
/**
 * Metric setup routes (routes/metricConfig.js, mounted at /api): signed-in only; the role metrics, the Virtual Battery and the combined
 * metrics (definitions, validation, preview), with the checks that answer 400 before anything is saved. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-metric-config-'));
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
  app.use('/api', require('../routes/metricConfig'));
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
  const { getConfig } = require('../modules/database');
  const routes = [['GET', '/api/role-metrics'], ['POST', '/api/role-metrics'], ['GET', '/api/battery-estimator'], ['POST', '/api/battery-estimator'], ['POST', '/api/battery-estimator/soc'],
    ['GET', '/api/combined-metrics'], ['POST', '/api/combined-metrics'], ['POST', '/api/combined-metrics/preview']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    // Role metrics
    let r = await call('GET', '/api/role-metrics');
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, {});
    r = await call('POST', '/api/role-metrics', { solar: 'pv_power', consumption: 'load_power' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true);
    assert.deepStrictEqual((await call('GET', '/api/role-metrics')).body, { solar: 'pv_power', consumption: 'load_power' });
    assert.deepStrictEqual(JSON.parse(getConfig('role_metrics')), { solar: 'pv_power', consumption: 'load_power' });
    // Virtual battery
    r = await call('GET', '/api/battery-estimator');
    assert.strictEqual(r.status, 200); for (const k of ['settings', 'effective', 'status', 'suggestions', 'chemistries']) assert.ok(k in r.body, `the Virtual Battery view has ${k}`);
    r = await call('POST', '/api/battery-estimator/soc', { soc: 'not a number' });
    assert.strictEqual(r.status, 400);
    // Combined metrics
    r = await call('GET', '/api/combined-metrics');
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.definitions, []); assert.ok(Array.isArray(r.body.functions) || typeof r.body.functions === 'object');
    r = await call('POST', '/api/combined-metrics', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /up to 100 definitions/);
    r = await call('POST', '/api/combined-metrics', { definitions: Array.from({ length: 101 }, () => ({})) });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/combined-metrics', { definitions: [{ name: '', fn: 'sum', inputs: ['a'] }] });
    assert.strictEqual(r.status, 400, 'a definition without a name is refused');
    const sum = { name: 'house_total', unit: 'W', fn: 'sum', inputs: ['load_a', 'load_b'] };
    r = await call('POST', '/api/combined-metrics', { definitions: [sum] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.definitions.length, 1);
    assert.strictEqual(JSON.parse(getConfig('combined_metrics'))[0].name, 'house_total');
    assert.ok(JSON.parse(getConfig('user_metrics')).some(m => m.name === 'house_total' && m.combined === true), 'the combined metric is listed with its unit');
    r = await call('POST', '/api/combined-metrics', { definitions: [{ ...sum, name: 'x', id: 'a1', inputs: ['y'] }, { ...sum, name: 'y', id: 'a2', inputs: ['x'] }] });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /loop/, 'metrics that use each other in a loop are refused');
    assert.strictEqual(JSON.parse(getConfig('combined_metrics')).length, 1, 'a refused save leaves the saved definitions as they were');
    r = await call('POST', '/api/combined-metrics/preview', { name: 'p', fn: 'nonsense', inputs: ['a'] });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/combined-metrics/preview', { name: 'p', unit: 'W', fn: 'sum', inputs: ['missing_a'] });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.inputs[0].name, 'missing_a'); assert.strictEqual(r.body.inputs[0].value, null);
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/metricConfig'\)\)/);
    assert.ok(!/app\.(get|post|use)\('\/api\/(role-metrics|battery-estimator|combined-metrics)/.test(src));
  } finally { server.close(); }
  console.log('ok - metric setup routes: signed-in only, roles, Virtual Battery and combined metrics validated and saved');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
