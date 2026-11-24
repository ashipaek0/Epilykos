'use strict';
const checks = require('./_checks');
/**
 * Automations API (routes/automations.js) behind sign-in, CSRF and the unlock:
 * - signed out gets nothing; saving and turning on need the password unlock,
 *   turning off, taking over, testing, deleting and pausing everything do not;
 * - bad definitions are explained and not saved; a dry run sends nothing;
 * - taking over stops one automation (for an hour or until resumed) and
 *   resuming starts it again; pause-all stops all, and starting again needs the unlock.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-automations-api-'));
process.chdir(tmp);
process.env.SETTINGS_PASSWORD = 'made-up-test-password';
const database = require('../modules/database');
database.initializeDatabase();
const express = require('express');
const session = require('express-session');
const { isAuthenticated } = require('../modules/sessionAuth');
const { csrfProtection, csrfToken } = require('../modules/csrfProtection');
const automations = require('../modules/automations');
const { createEngine } = require('../modules/automations/engine');
const deviceActions = require('../modules/deviceActions');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

(async () => {
  database.setConfig('tuya_devices', JSON.stringify([{ name: 'Geyser', enabled: true, dps: { relay: 1 } }]));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
  app.get('/signin', (q, s) => { q.session.authenticated = true; s.send('ok'); });
  app.get('/api/csrf-token', csrfToken);
  app.use('/api/controls', isAuthenticated, csrfProtection, require('../routes/controls'));
  app.use('/api/automations', isAuthenticated, csrfProtection, require('../routes/automations'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let cookie = '', token;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', ...(token ? { 'X-CSRF-Token': token } : {}), 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let t = ''; res.on('data', c => { t += c; });
      res.on('end', () => { if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; let j = null; try { j = JSON.parse(t); } catch { /* empty */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const def = over => ({ name: 'Geyser on sun', when: [{ type: 'metric', metric: 'battery_soc', operator: 'gt', value: 90 }], then: [{ target: { source: 'tuya', device: 'Geyser', entity: 'relay' }, op: 'on' }], ...over });
  try {
    await check('signed out gets nothing', async () => {
      for (const [m, p] of [['GET', '/api/automations'], ['GET', '/api/automations/catalog'], ['POST', '/api/automations'], ['POST', '/api/automations/pause-all'], ['DELETE', '/api/automations/1']]) {
        assert.strictEqual((await call(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
      }
    });
    await call('GET', '/signin');
    token = (await call('GET', '/api/csrf-token')).body.token;

    let id;
    await check('saving needs the unlock; bad definitions are explained; a good one is saved turned off', async () => {
      assert.strictEqual((await call('POST', '/api/automations', def())).status, 423);
      assert.strictEqual((await call('POST', '/api/controls/unlock', { password: 'made-up-test-password' })).status, 200);
      const bad = await call('POST', '/api/automations', def({ then: [{ target: { source: 'dongle', device: 'x', entity: '0x69' }, op: 'set', value: 1 }] }));
      assert.strictEqual(bad.status, 400); assert.match(bad.body.error, /not available/);
      assert.strictEqual((await call('GET', '/api/automations')).body.automations.length, 0);
      const ok = await call('POST', '/api/automations', def());
      assert.strictEqual(ok.status, 201); assert.strictEqual(ok.body.enabled, false); id = ok.body.id;
      const cat = (await call('GET', '/api/automations/catalog')).body;
      assert.ok(cat.targets.some(t => t.key === 'tuya|Geyser|relay'));
      assert.ok(Array.isArray(cat.metrics));
    });

    await check('turning on needs the unlock; turning off does not', async () => {
      await call('POST', '/api/controls/lock');
      assert.strictEqual((await call('POST', `/api/automations/${id}/enable`)).status, 423);
      assert.strictEqual((await call('PUT', `/api/automations/${id}`, def({ name: 'x' }))).status, 423);
      await call('POST', '/api/controls/unlock', { password: 'made-up-test-password' });
      assert.strictEqual((await call('POST', `/api/automations/${id}/enable`)).body.enabled, true);
      await call('POST', '/api/controls/lock');
      assert.strictEqual((await call('POST', `/api/automations/${id}/disable`)).body.enabled, false);
      assert.strictEqual((await call('POST', '/api/automations/999/disable')).status, 404);
      await call('POST', '/api/controls/unlock', { password: 'made-up-test-password' });
      const ed = await call('PUT', `/api/automations/${id}`, def({ name: 'Renamed', enabled: true }));
      assert.strictEqual(ed.body.name, 'Renamed'); assert.strictEqual(ed.body.enabled, true);
    });

    await check('a test run reads but never sends', async () => {
      const sent = []; deviceActions.adapters.tuya = async (...a) => { sent.push(a); return { success: true }; };
      const r = await call('POST', '/api/automations/dry-run', def());
      assert.strictEqual(r.status, 200); assert.strictEqual(r.body.met, null, 'no reading yet: undecided');
      assert.strictEqual(sent.length, 0);
      assert.strictEqual((await call('POST', '/api/automations/dry-run', def({ name: '' }))).status, 400);
    });

    await check('take over stops one automation; resume starts it again', async () => {
      const sent = [];
      const metrics = { battery_soc: { value: 95, timestamp: Date.now() }, relay: { value: 'off', timestamp: Date.now() } };
      const engine = createEngine({ ...automations.realDeps(), getMetrics: () => metrics, paused: () => automations.isPaused(),
        send: async (e, s) => { sent.push(s.op); return { ok: true }; } });
      await engine.tick(); assert.deepStrictEqual(sent, ['on'], 'running');
      engine.reset(); sent.length = 0;
      const t = await call('POST', `/api/automations/${id}/takeover`, { hours: 1 });
      assert.strictEqual(t.status, 200); assert.strictEqual(t.body.takenOver, true); assert.ok(t.body.paused_until > Date.now());
      await engine.tick(); assert.strictEqual(sent.length, 0, 'taken over: left alone');
      const until = await call('POST', `/api/automations/${id}/takeover`, { untilResumed: true });
      assert.strictEqual(until.body.paused_until, -1); assert.strictEqual(until.body.takenOver, true);
      assert.strictEqual((await call('GET', '/api/automations')).body.automations[0].takenOver, true);
      const back = await call('POST', `/api/automations/${id}/resume`);
      assert.strictEqual(back.body.takenOver, false);
      await engine.tick(); assert.strictEqual(sent.length, 1, 'resumed');
      engine.reset(); sent.length = 0;
      await call('POST', `/api/automations/${id}/takeover`, { hours: 0.0001 });
      await new Promise(r => setTimeout(r, 400));
      await engine.tick(); assert.strictEqual(sent.length, 1, 'a short take over ends by itself');
      await call('POST', `/api/automations/${id}/takeover`, { untilResumed: true });
      const edited = await call('PUT', `/api/automations/${id}`, def({ name: 'Again', enabled: true }));
      assert.strictEqual(edited.body.paused_until, -1, 'editing does not end a take over');
      await call('POST', `/api/automations/${id}/resume`);
    });

    await check('pause all stops everything; starting again needs the unlock', async () => {
      const sent = [];
      const metrics = { battery_soc: { value: 95, timestamp: Date.now() }, relay: { value: 'off', timestamp: Date.now() } };
      const engine = createEngine({ ...automations.realDeps(), getMetrics: () => metrics, paused: () => automations.isPaused(), send: async (e, s) => { sent.push(s.op); return { ok: true }; } });
      await call('POST', '/api/controls/lock');
      const p = await call('POST', '/api/automations/pause-all', { paused: true });
      assert.strictEqual(p.status, 200); assert.strictEqual(p.body.paused, true);
      assert.deepStrictEqual(await engine.tick(), { skipped: 'paused' }); assert.strictEqual(sent.length, 0);
      assert.strictEqual((await call('POST', '/api/automations/pause-all', { paused: false })).status, 423);
      await call('POST', '/api/controls/unlock', { password: 'made-up-test-password' });
      assert.strictEqual((await call('POST', '/api/automations/pause-all', { paused: false })).body.paused, false);
      await engine.tick(); assert.strictEqual(sent.length, 1);
    });

    await check('delete, the run log, and the change log records who did what', async () => {
      assert.strictEqual((await call('DELETE', `/api/automations/${id}`)).body.success, true);
      assert.strictEqual((await call('DELETE', `/api/automations/${id}`)).status, 404);
      assert.ok(Array.isArray((await call('GET', '/api/automations/runs?limit=5')).body.runs));
      const labels = require('../modules/deviceControls').recentLog(50).filter(r => r.source === 'automations').map(r => r.label);
      for (const l of ['Automation created', 'Automation turned on', 'Automation turned off', 'Automation taken over', 'Automation resumed', 'Automation deleted', 'Automations paused']) assert.ok(labels.includes(l), l);
    });
  } finally { server.close(); }
  checks.done(passed);
})().catch(e => { console.error(e); process.exit(1); });
