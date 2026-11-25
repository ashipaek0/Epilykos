'use strict';
const checks = require('./_checks');
/**
 * Modbus and RS232 routes (routes/profiles.js, mounted at /api): signed-in only; the profile lists, one profile and its
 * entity catalog (found, or 404), the serial ports, and the test connections' checks that answer before a device is dialled. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-profile-routes-'));
process.chdir(tmp);
process.env.SETTINGS_PASSWORD = 'made-up-test-password';
require('../modules/database').initializeDatabase();
require('../modules/modbus').loadProfiles();
require('../modules/rs232').loadRs232Profiles();
const express = require('express');
const session = require('express-session');

(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false, cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax' } }));
  app.get('/signin', (q, s) => { q.session.authenticated = true; s.send('ok'); });
  app.use('/api', require('../routes/profiles'));
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
  const routes = [['GET', '/api/modbus/profiles'], ['GET', '/api/modbus/profile/x'], ['GET', '/api/modbus/profile/x/entities'], ['POST', '/api/test-modbus'],
    ['GET', '/api/rs232/profiles'], ['GET', '/api/rs232/profile/x'], ['GET', '/api/rs232/profile/x/entities'], ['GET', '/api/rs232/ports'], ['POST', '/api/test-rs232']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    for (const kind of ['modbus', 'rs232']) {
      let r = await call('GET', `/api/${kind}/profiles`);
      assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.body) && r.body.length > 0 && r.body.every(p => p.id && p.name), `${kind} profiles listed`);
      const id = encodeURIComponent(r.body[0].id);
      r = await call('GET', `/api/${kind}/profile/${id}`);
      assert.strictEqual(r.status, 200, `${kind} profile ${id}`);
      r = await call('GET', `/api/${kind}/profile/${id}/entities`);
      assert.strictEqual(r.status, 200, `${kind} entities ${id}`); assert.ok(Array.isArray(r.body.entities || r.body), `${kind} entity list`);
      assert.strictEqual((await call('GET', `/api/${kind}/profile/no-such-profile`)).status, 404);
      assert.strictEqual((await call('GET', `/api/${kind}/profile/no-such-profile/entities`)).status, 404);
    }
    let r = await call('GET', '/api/rs232/ports');
    assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.body));
    r = await call('POST', '/api/test-modbus', { transport: 'tcp' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Host required/);
    r = await call('POST', '/api/test-modbus', { transport: 'serial' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Serial path required/);
    r = await call('POST', '/api/test-rs232', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Serial path required/);
    r = await call('POST', '/api/test-rs232', { serial_path: '/dev/ttyUSB9' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Profile required/);
    // The catalogs are pure projections of a parsed profile.
    const { modbusProfileEntities, rs232ProfileEntities } = require('../routes/profiles');
    assert.deepStrictEqual(modbusProfileEntities({ registers: [{ address: 7, metric: 'b' }, { address: 3, metric: 'a' }, { address: 9 }] }).map(e => e.id), ['3', '7']);
    assert.deepStrictEqual(rs232ProfileEntities(null), []);
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/profiles'\)\)/);
    assert.ok(!/app\.(get|post|use)\('\/api\/(modbus|rs232|test-modbus|test-rs232)/.test(src));
  } finally { server.close(); }
  console.log('ok - modbus and rs232 routes: signed-in only, profiles and entity catalogs served, 404 for unknown ones, bad tests refused');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
