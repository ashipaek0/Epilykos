'use strict';
const checks = require('./_checks');
/**
 * Settings → InfluxDB (routes/influx.js, modules/influx/settings.js): signed-in only; the connection is saved encrypted and
 * never sent back with its token or password; an empty secret keeps the saved one only for the same server; discovery and
 * the Home Assistant suggestions read the saved connection; the mapping and write settings are checked before saving; the
 * keys cannot be written through /api/settings; and the page is wired in.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-influx-settings-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const express = require('express');
const session = require('express-session');
const s = require('../modules/influx/settings');
const { isProtectedKey } = require('../modules/protectedConfig');
const { createFakeInflux, fluxCsv, directFetch } = require('./_fake-influx');
const { createInfluxClient } = require('../modules/influx/client');

// ── Pure helpers ────────────────────────────────────────────────────────
assert.deepStrictEqual(s.normaliseConnection({ version: '2', url: ' http://h ', org: 'o', bucket: 'b', token: ' t ', database: 'x' }),
  { version: '2', url: 'http://h', org: 'o', bucket: 'b', token: 't' }, 'only the fields of its version');
const saved = { version: '2', url: 'http://h', org: 'o', bucket: 'b', token: 'old' };
assert.strictEqual(s.mergeConnection({ ...saved, token: '' }, saved).token, 'old', 'empty token keeps the saved one');
assert.strictEqual(s.mergeConnection({ ...saved, url: 'http://elsewhere', token: '' }, saved).token, '', 'but not for another server');
assert.strictEqual(s.mergeConnection({ ...saved, bucket: 'other', token: '' }, saved).token, '', 'or another bucket');
const saved1 = { version: '1', url: 'http://h', database: 'd', username: 'u', password: 'pw' };
assert.strictEqual(s.mergeConnection({ ...saved1, password: '' }, saved1).password, 'pw');
assert.strictEqual(s.mergeConnection({ ...saved1, username: 'v', password: '' }, saved1).password, '', 'another user does not get the password');

assert.match(s.validateMapping('x').error, /list/);
assert.match(s.validateMapping([{ metric: 'pv' }]).error, /measurement and the field/);
assert.match(s.validateMapping([{ metric: 'pv', measurement: 'W', field: 'value' }, { metric: 'pv', measurement: 'W', field: 'v2' }]).error, /mapped twice/);
assert.match(s.validateMapping([{ metric: 'pv', measurement: 'W', field: 'value', tags: { entity_id: '' } }]).error, /both a name and a value/);
assert.match(s.validateMapping([{ metric: 'pv', measurement: 'W', field: 'value', scale: 0 }]).error, /scale/);
assert.match(s.validateMapping([{ metric: 'p\nv', measurement: 'W', field: 'value' }]).error, /metric/, 'control characters are not a name');
assert.deepStrictEqual(s.validateMapping([{ metric: ' pv ', measurement: 'kW', field: 'value', tags: { entity_id: 'pv', '': '' }, scale: '1000' }]).mapping,
  [{ metric: 'pv', measurement: 'kW', field: 'value', tags: { entity_id: 'pv' }, scale: 1000 }]);
assert.deepStrictEqual(s.normaliseWrite({}), { measurement: 'epilykos', all: false });
assert.deepStrictEqual(s.normaliseWrite({ measurement: 'mine', all: true }), { measurement: 'mine', all: true });

const sug = s.suggestHomeAssistant([{ measurement: 'W', entityIds: ['pv_power', 'fridge'] }, { measurement: '%', entityIds: ['battery_soc'] }], ['Battery_SOC', 'pv_power']);
assert.deepStrictEqual(sug.map(r => [r.metric, r.measurement, r.tags.entity_id, r.known]),
  [['Battery_SOC', '%', 'battery_soc', true], ['pv_power', 'W', 'pv_power', true], ['fridge', 'W', 'fridge', false]], 'known metrics first, matched without case');

assert.strictEqual(s.suggestMetricName({ measurement: 'W', field: 'value', tags: { entity_id: 'sensor.PV Power', domain: 'sensor' } }), 'pv_power', 'Home Assistant: the entity id');
assert.strictEqual(s.suggestMetricName({ measurement: 'cpu', field: 'usage_idle', tags: { host: 'pi', cpu: 'cpu-total' } }), 'cpu_total_pi_usage_idle', 'tag values, then the field');
assert.strictEqual(s.suggestMetricName({ measurement: 'Grid Meter', field: 'power', tags: {} }), 'grid_meter_power', 'no tags: the measurement');
assert.strictEqual(s.suggestMetricName({ measurement: '°', field: '%', tags: {} }), 'influx_metric', 'nothing usable: a placeholder');
assert.ok(s.suggestMetricName({ measurement: 'm', field: 'f', tags: { a: 'x'.repeat(200) } }).length <= 64);

for (const k of [s.CONNECTION_KEY, s.MAPPING_KEY, s.WRITE_KEY, 'influx_state']) assert.ok(isProtectedKey(k), `${k} cannot be written through /api/settings`);

// ── Routes ──────────────────────────────────────────────────────────────
(async () => {
  const fake = createFakeInflux({ version: '2', token: 'tok-1', answer: (kind, q) => {
    if (q.startsWith('buckets()')) return fluxCsv([{ name: 'ha' }]);
    if (q.includes('schema.measurements')) return fluxCsv([{ _value: 'W' }, { _value: 'state' }]);
    if (q.includes('measurementFieldKeys')) return q.includes('"W"') ? fluxCsv([{ _value: 'value' }]) : fluxCsv([{ _value: 'state' }]);
    if (q.includes('measurementTagKeys')) return fluxCsv([{ _value: 'entity_id' }, { _value: 'domain' }]);
    if (q.includes('measurementTagValues')) return fluxCsv([{ _value: 'pv_power' }, { _value: 'load' }]);
    if (q.includes('|> last()')) return q.includes('"W"')
      ? fluxCsv([{ _time: '2026-11-01T00:00:00Z', _value: 1500, _field: 'value', _measurement: 'W', entity_id: 'pv_power', domain: 'sensor' }])
      : fluxCsv([{ _time: '2026-11-01T00:00:00Z', _value: 3, _field: 'used', _measurement: 'state', host: 'pi' }]);
    return '';
  } });
  const fakeUrl = await fake.listen();
  const router = require('../routes/influx');
  router.clientFor = conn => createInfluxClient(conn, { fetchImpl: directFetch });   // the fake is on loopback

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
  app.get('/signin', (q, r) => { q.session.authenticated = true; r.send('ok'); });
  app.use('/api/influx', require('../modules/sessionAuth').isAuthenticated, router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let cookie = '';
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let t = ''; res.on('data', c => { t += c; });
      res.on('end', () => { if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; let j = null; try { j = JSON.parse(t); } catch { /* empty */ } resolve({ status: res.statusCode, body: j, text: t }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  try {
    for (const p of ['/', '/connection', '/test', '/discover', '/suggest-ha', '/browse-series', '/mapping', '/write-settings', '/disconnect']) {
      const r = await call(p === '/' ? 'GET' : 'POST', '/api/influx' + p, p === '/' ? undefined : {});
      assert.strictEqual(r.status, 401, `${p} signed out`);
    }
    await call('GET', '/signin');
    let r = await call('GET', '/api/influx');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.configured, false);
    assert.strictEqual((await call('POST', '/api/influx/discover', {})).status, 400, 'nothing to discover before a connection is saved');

    r = await call('POST', '/api/influx/connection', { version: '2', url: fakeUrl, org: 'home', bucket: 'ha' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /token/);
    r = await call('POST', '/api/influx/test', { version: '2', url: fakeUrl, org: 'home', bucket: 'ha', token: 'wrong' });
    assert.strictEqual(r.status, 422); assert.match(r.body.error, /refused the token/);
    r = await call('POST', '/api/influx/connection', { version: '2', url: fakeUrl, org: 'home', bucket: 'ha', token: 'tok-1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.configured, true);
    assert.strictEqual(r.body.connection.hasToken, true);
    assert.ok(!r.text.includes('tok-1'), 'the token is never sent back');
    const stored = database.getDb().prepare('SELECT value FROM config WHERE key = ?').get(s.CONNECTION_KEY).value;
    assert.ok(!stored.includes('tok-1') && stored.includes('$enc1$'), 'and is stored encrypted');
    assert.strictEqual(s.loadConnection().token, 'tok-1');
    r = await call('POST', '/api/influx/test', { version: '2', url: fakeUrl, org: 'home', bucket: 'ha', token: '' });
    assert.strictEqual(r.status, 200, 'a test with the token left empty uses the saved one');

    r = await call('POST', '/api/influx/discover', {});
    assert.deepStrictEqual(r.body.measurements, ['W', 'state']);
    r = await call('POST', '/api/influx/discover', { measurement: 'W' });
    assert.deepStrictEqual(r.body, { fields: [{ name: 'value', type: null }], tagKeys: ['domain', 'entity_id'] });
    r = await call('POST', '/api/influx/discover', { measurement: 'W', tagKey: 'entity_id' });
    assert.deepStrictEqual(r.body.values, ['load', 'pv_power']);

    database.getDb().prepare('INSERT INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run('pv_power', 1, 1);
    r = await call('POST', '/api/influx/suggest-ha', {});
    assert.deepStrictEqual(r.body.rows.map(x => [x.metric, x.measurement, x.known]), [['pv_power', 'W', true], ['load', 'W', false]],
      'only measurements with an entity_id tag and a value field');

    r = await call('POST', '/api/influx/browse-series', {});
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.series.map(x => [x.measurement, x.field, x.metric, x.known, x.last]), [['W', 'value', 'pv_power', true, 1500], ['state', 'used', 'pi_used', false, 3]],
      'every measurement, whatever wrote it; a known metric marked');
    r = await call('POST', '/api/influx/browse-series', { measurement: 'state' });
    assert.deepStrictEqual(r.body.series.map(x => x.measurement), ['state'], 'or one measurement');
    database.setConfig(s.WRITE_KEY, JSON.stringify({ measurement: 'state', all: false }));
    r = await call('POST', '/api/influx/browse-series', {});
    assert.deepStrictEqual(r.body.series.map(x => x.measurement), ['W'], 'never the measurement Epilykos writes its own readings to');
    database.setConfig(s.WRITE_KEY, '');
    r = await call('POST', '/api/influx/mapping', { mapping: [{ metric: 'pv_power', measurement: 'W', field: 'value', tags: { entity_id: 'pv_power' } }, { metric: 'x' }] });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/influx/mapping', { mapping: [{ metric: 'pv_power', measurement: 'W', field: 'value', tags: { entity_id: 'pv_power' } }] });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.mapping.length, 1);
    r = await call('POST', '/api/influx/write-settings', { measurement: 'from_epilykos', all: true });
    assert.deepStrictEqual(r.body.write, { measurement: 'from_epilykos', all: true });

    r = await call('POST', '/api/influx/disconnect', {});
    assert.strictEqual(r.body.configured, false);
    assert.strictEqual(r.body.mapping.length, 1, 'the mapping is kept');
  } finally {
    server.close(); await fake.close();
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /app\.use\('\/api\/influx', isAuthenticated, require\('\.\/routes\/influx'\)\)/);
  const html = fs.readFileSync(path.join(root, 'public', 'settings.html'), 'utf8');
  assert.ok(html.includes('id="section-influxdb"') && html.includes('href="#influxdb"') && html.includes('js/influx-settings.js'));
  assert.match(fs.readFileSync(path.join(root, 'public', 'js', 'settings-shell.js'), 'utf8'), /influxdb: 'InfluxDB'/);
  assert.deepStrictEqual(require('../modules/encryption').SECRET_FIELDS.influx_connection, ['password', 'token']);
  assert.ok(!/innerHTML/.test(fs.readFileSync(path.join(root, 'public', 'js', 'influx-settings.js'), 'utf8')), 'the page draws with textContent');
  console.log('ok - influx settings');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
