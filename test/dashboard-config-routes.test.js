'use strict';
const checks = require('./_checks');
/**
 * Dashboard layout routes (routes/dashboardConfig.js, mounted at /api) and the upload helpers (modules/uploads.js): signed-in only; save,
 * export as a file, and import from an upload (merged with the dashboards already there, or replacing them); an upload outside its
 * folder is refused; only .db and .json files, at most 50 MB. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-dashboard-config-'));
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
  const uploads = require('../modules/uploads').createUploads();
  const fakeUpload = { single: () => (q, s, next) => { const f = q.headers['x-test-file']; if (f) q.file = { path: f }; next(); } };
  const { getDashboardConfig } = require('../modules/dashboard-config');
  app.use('/api', require('../routes/dashboardConfig')({ upload: fakeUpload, uploadedFilePath: uploads.uploadedFilePath }));
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
  const routes = [['POST', '/api/dashboard-config'], ['GET', '/api/dashboard-config/export'], ['POST', '/api/dashboard-config/import']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    await call('GET', '/signin');
    const layout = { activeDashboard: 'main', dashboards: [{ id: 'main', name: 'Main', layout: [] }] };
    let r = await call('POST', '/api/dashboard-config', layout);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true);
    assert.deepStrictEqual(getDashboardConfig().dashboards.map(d => d.id), ['main']);
    // Export: the layout as a file.
    const exported = await new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: '/api/dashboard-config/export', headers: { Cookie: cookie } }, res => { let txt = ''; res.on('data', c => { txt += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(txt) })); });
      q.on('error', reject); q.end();
    });
    assert.strictEqual(exported.status, 200); assert.match(exported.headers['content-disposition'], /attachment; filename="dashboard-layout\.json"/);
    assert.deepStrictEqual(exported.body.dashboards.map(d => d.id), ['main']);
    // Import
    const send = (file, query = '') => new Promise((resolve, reject) => {
      const data = '{}';
      const q = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/dashboard-config/import' + query, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': 2, ...(file ? { 'x-test-file': file } : {}) } }, res => { let txt = ''; res.on('data', c => { txt += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(txt) })); });
      q.on('error', reject); q.write(data); q.end();
    });
    const upload = (name, content) => { const f = path.join(uploads.uploadDir, name); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); return f; };
    r = await send(null);
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /No file uploaded/);
    const outside = path.join(tmp, 'outside.json'); fs.writeFileSync(outside, JSON.stringify(layout));
    r = await send(outside);
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Invalid upload/); assert.ok(fs.existsSync(outside), 'a file outside the upload folder is not touched');
    // Merge: an id already there is renamed, the dashboard named as imported.
    let f = upload('a.json', { dashboards: [{ id: 'main', name: 'Mine', layout: [] }, { id: 'extra', name: 'Extra', layout: [] }] });
    r = await send(f);
    assert.strictEqual(r.status, 200); assert.ok(!fs.existsSync(f), 'the upload is removed');
    const merged = getDashboardConfig().dashboards;
    assert.strictEqual(merged.length, 3); assert.ok(merged.some(d => d.id === 'extra'));
    assert.ok(merged.some(d => d.name === 'Mine (imported)' && d.id !== 'main' && /^db_/.test(d.id)), 'a colliding id is renamed and marked as imported');
    // Replace
    f = upload('b.json', { activeDashboard: 'only', dashboards: [{ id: 'only', name: 'Only', layout: [] }] });
    r = await send(f, '?merge=false');
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(getDashboardConfig().dashboards.map(d => d.id), ['only']);
    // Bad content
    for (const content of ['not json', JSON.stringify({ dashboards: 'x' }), JSON.stringify({})]) {
      f = upload('bad.json', content);
      r = await send(f);
      assert.strictEqual(r.status, 500); assert.strictEqual(r.body.error, 'Internal server error', 'the parse error is not shown');
      assert.ok(!fs.existsSync(f), 'a refused upload is removed too');
    }
    assert.deepStrictEqual(getDashboardConfig().dashboards.map(d => d.id), ['only'], 'a refused import changes nothing');
    // The upload helpers
    assert.strictEqual(uploads.uploadedFilePath({ path: path.join(uploads.uploadDir, 'x.json') }), path.join(uploads.uploadDir, 'x.json'));
    for (const bad of [{ path: '/etc/passwd' }, { path: path.join(uploads.uploadDir, '..', 'escape.json') }, { path: uploads.uploadDir }, {}, null, undefined]) assert.strictEqual(uploads.uploadedFilePath(bad), null, 'outside the folder: ' + JSON.stringify(bad));
    assert.strictEqual(fs.statSync(uploads.uploadDir).mode & 0o077, 0, 'the folder is readable by this process only');
    assert.strictEqual(require('../modules/uploads').MAX_BYTES, 50 * 1024 * 1024);
    // The server mounts it; the routes are not defined in server.js any more.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /require\('\.\/routes\/dashboardConfig'\)\(\{ upload, uploadedFilePath \}\)/);
    assert.ok(!/app\.(get|post|use)\('\/api\/dashboard-config/.test(src));
    uploads.remove(); assert.ok(!fs.existsSync(uploads.uploadDir), 'remove() deletes the folder');
  } finally { server.close(); }
  console.log('ok - dashboard layout routes: signed-in only, export, merge and replace imports, bad files refused and removed');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
