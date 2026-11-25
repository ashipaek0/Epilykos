'use strict';
const checks = require('./_checks');
/**
 * Home Assistant and MQTT routes (routes/integrations.js, mounted at /api): signed-in only; the checks that answer 400 before
 * anything is dialled (missing URL or token, bad entity ids, no broker), the switchable entities, the discovery cache, and the
 * pure helpers (entity catalog, payload type inference, plain-language Home Assistant errors). */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-integration-routes-'));
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
  app.use('/api', require('../routes/integrations'));
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
  const routes = [['POST', '/api/ha-device-entities'], ['POST', '/api/ha/entities'], ['GET', '/api/switchable-entities'], ['GET', '/api/entity-actions?entity=a.b'],
    ['POST', '/api/ha/entity-actions'], ['POST', '/api/test-mqtt'], ['POST', '/api/test-mqtt-topic'], ['POST', '/api/mqtt-discover-topics'], ['GET', '/api/mqtt-discovery-cache']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    let r = await call('POST', '/api/ha-device-entities', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /HA URL and token required/);
    r = await call('POST', '/api/ha/entities', {});
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/ha-device-entities', { url: 'http://127.0.0.1:1', token: 'x' });
    assert.strictEqual(r.status, 400, 'a loopback Home Assistant address is refused before any request');
    assert.strictEqual((await call('GET', '/api/entity-actions')).status, 400);
    assert.strictEqual((await call('GET', '/api/entity-actions?entity=' + 'x'.repeat(129))).status, 400);
    r = await call('GET', '/api/entity-actions?entity=switch.lamp');
    assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.body.actions));
    r = await call('POST', '/api/ha/entity-actions', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Valid entity ID required/);
    r = await call('POST', '/api/ha/entity-actions', { entityId: 'not an entity' });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/test-mqtt', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /No MQTT broker/);
    r = await call('GET', '/api/switchable-entities');
    assert.strictEqual(r.status, 200);
    r = await call('GET', '/api/mqtt-discovery-cache');
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Broker URL required/);
    r = await call('GET', '/api/mqtt-discovery-cache?broker=' + encodeURIComponent('mqtt://192.168.0.5:1883'));
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.entries, []); assert.strictEqual(r.body.ts, null);
    // The pure helpers.
    const { haStatesToCatalog, mqttSampleOf, haErrorResponse } = require('../routes/integrations');
    const cat = haStatesToCatalog([{ entity_id: 'switch.lamp', state: 'on', attributes: { friendly_name: 'Lamp' } }, { entity_id: 'person.me', state: 'home' }, null, { entity_id: '' }]);
    assert.deepStrictEqual(cat.map(e => [e.id, e.label, e.domain, e.kind]), [['switch.lamp', 'Lamp', 'switch', 'ha']], 'only mappable domains, named by friendly name');
    assert.deepStrictEqual(haStatesToCatalog('x'), []);
    assert.deepStrictEqual([mqttSampleOf('12.5', true).type, mqttSampleOf('TRUE', false).value, mqttSampleOf('{"a":1}').type], ['number', true, 'string']);
    assert.strictEqual(mqttSampleOf('1e3').value, 1000);
    assert.strictEqual(haErrorResponse({ haStatus: 401 }, 'u').code, 502);
    assert.match(haErrorResponse({ haStatus: 404 }, 'http://ha:8123').error, /http:\/\/ha:8123/);
    assert.strictEqual(haErrorResponse({ cause: { code: 'ECONNREFUSED' } }, 'u').code, 502);
    assert.strictEqual(haErrorResponse({ name: 'TimeoutError' }, 'u').code, 504);
    assert.strictEqual(haErrorResponse(new Error('x'), 'u').code, 500);
    const { stringFields } = require('../modules/requestFields');
    assert.deepStrictEqual(stringFields({ a: 'x', b: 2, c: NaN, d: {}, e: null }), { a: 'x', b: '2' });
    assert.deepStrictEqual(stringFields([1]), {});
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/integrations'\)\)/);
    assert.ok(!/app\.(get|post|use)\('\/api\/(ha\/|ha-device-entities|entity-actions|switchable-entities|test-mqtt|mqtt-)/.test(src));
  } finally { server.close(); }
  console.log('ok - Home Assistant and MQTT routes: signed-in only, bad requests refused before anything is dialled, helpers behave');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
