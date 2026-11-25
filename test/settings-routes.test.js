'use strict';
const checks = require('./_checks');
/**
 * Settings routes (routes/settings.js, mounted at /api): signed-in only; reading and saving settings; secrets, protected and
 * notification keys refused; bad numbers and clashing source names answered with 400 before anything is saved. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-settings-routes-'));
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
  app.use('/api', require('../routes/settings'));
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
  const routes = [['GET', '/api/settings'], ['POST', '/api/settings'], ['POST', '/api/settings/data-sources'], ['POST', '/api/settings/metrics'], ['POST', '/api/settings/dashboard'],
    ['POST', '/api/settings/solar'], ['POST', '/api/settings/savings'], ['POST', '/api/savings/recalculate'], ['POST', '/api/settings/branding'], ['POST', '/api/settings/network'], ['POST', '/api/settings/backup']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    let r = await call('POST', '/api/settings', { dashboard_title: 'My Solar', solar_latitude: '6.5' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true);
    r = await call('GET', '/api/settings');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.dashboard_title, 'My Solar'); assert.strictEqual(r.body.solar_latitude, '6.5');
    // Refused, silently: secrets, settings with their own route, notification keys.
    r = await call('POST', '/api/settings', { dashboard_title: 'Kept', api_token: 'x', login_password: 'x', session_secret: 'x', device_writes_enabled: 'true', setup_password_set: '1', notification_rules: '[]', notification_x: 'y' });
    assert.strictEqual(r.status, 200);
    for (const k of ['api_token', 'login_password', 'device_writes_enabled', 'setup_password_set', 'notification_rules', 'notification_x']) assert.ok(getConfig(k) == null || getConfig(k) === '', `${k} was not saved`);
    assert.notStrictEqual(getConfig('session_secret'), 'x');
    assert.strictEqual(getConfig('dashboard_title'), 'Kept', 'the ordinary key in the same request was saved');
    // null is stored as an empty string, undefined is skipped.
    await call('POST', '/api/settings', { dashboard_title: null });
    assert.strictEqual(getConfig('dashboard_title'), '');
    // Bad numbers and clashing names are refused before anything is saved.
    r = await call('POST', '/api/settings', { solcast_daily_limit: 'x', dashboard_title: 'Not saved' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /solcast_daily_limit/); assert.notStrictEqual(getConfig('dashboard_title'), 'Not saved');
    const same = [{ name: 'Inv', enabled: true, profile: 'p' }, { name: 'Inv', enabled: true, profile: 'p' }];
    r = await call('POST', '/api/settings', { dongle_config: JSON.stringify(same) });
    assert.strictEqual(r.status, 400, 'two dongles with one name');
    r = await call('POST', '/api/settings/data-sources', { dongle_config: JSON.stringify(same) });
    assert.strictEqual(r.status, 400, 'the same refusal on the data-sources section');
    // Per-section saves keep to their own keys.
    r = await call('POST', '/api/settings/branding', { dashboard_title: 'Branded', device_writes_enabled: 'true' });
    assert.strictEqual(r.status, 200); assert.strictEqual(getConfig('dashboard_title'), 'Branded');
    assert.ok(getConfig('device_writes_enabled') == null || getConfig('device_writes_enabled') === 'false' || getConfig('device_writes_enabled') === '', 'a section cannot switch on device writes');
    r = await call('POST', '/api/settings/savings', { savings_rate: '210', savings_currency: 'N' });
    assert.strictEqual(r.status, 200); assert.strictEqual(getConfig('savings_rate'), '210');
    r = await call('POST', '/api/settings/savings', { savings_rate: '-5' });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/settings/backup', {});
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, { ok: true, saved: [] });
    r = await call('POST', '/api/savings/recalculate', {});
    assert.strictEqual(r.status, 200);
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.use\('\/api', require\('\.\/routes\/settings'\)\)/);
    assert.ok(!/app\.(get|post|use)\('\/api\/(settings|savings)/.test(src));
  } finally { server.close(); }
  console.log('ok - settings routes: signed-in only, ordinary keys saved, secrets and protected keys refused, bad input refused before saving');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
