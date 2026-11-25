'use strict';
const checks = require('./_checks');
/**
 * Restore and snapshot routes (routes/restore.js, mounted at /api): signed-in only; a restore needs an upload that sits in the upload
 * folder; every failure is answered as restoreFailure says (a bad file is 400, a refusal keeps its status, anything else is a plain 500);
 * the session handover brackets the swap. The database swap itself is covered by restore-http-runtime and restore-upload-http. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-routes-'));
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
  const calls = [];
  const fakes = {
    restoreDatabase: async (file, opts) => { calls.push(['restore', file, Object.keys(opts).sort()]); if (file.endsWith('bad.db')) { const e = new Error('x'); e.code = 'SQLITE_NOTADB'; throw e; } if (file.endsWith('refused.db')) { const e = new Error('Needs a passphrase'); e.status = 403; throw e; } if (file.endsWith('boom.db')) throw new Error('disk on fire'); },
    restoreFromSnapshot: async (name, opts) => { calls.push(['snapshot', name]); if (name === 'gone') { const e = new Error('No such snapshot'); e.status = 404; throw e; } return { success: true, name }; },
    listSnapshots: () => [{ name: 'snap-1' }],
    restoreLifecycle: { id: 'lifecycle' },
    sessionStore: { captureForRestore: id => { calls.push(['capture', id]); return { id }; }, restoreCaptured: rec => calls.push(['restored', rec.id]) },
    upload: { single: () => (q, s, next) => { const f = q.headers['x-test-file']; if (f) q.file = { path: f }; next(); } },
    uploadedFilePath: file => (file.path.startsWith('/uploads/') ? file.path : null)
  };
  const created = require('../routes/restore')(fakes);
  app.use('/api', created.router);
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
  const routes = [['POST', '/api/restore'], ['GET', '/api/snapshots/status'], ['GET', '/api/snapshots'], ['POST', '/api/snapshots/restore/x']];
  try {
    for (const [m, p] of routes) assert.strictEqual((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} signed out`);
    assert.strictEqual(calls.length, 0, 'nothing ran while signed out');
    await call('GET', '/signin');
    let r = await call('POST', '/api/restore', {});
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /No file uploaded/);
    const send = (file, body = {}) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const q = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/restore', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-test-file': file } }, res => {
        let txt = ''; res.on('data', c => { txt += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(txt) }));
      }); q.on('error', reject); q.write(data); q.end();
    });
    r = await send('/elsewhere/x.db');
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Invalid upload/);
    assert.ok(!calls.some(c => c[0] === 'restore'), 'an upload outside its folder is never restored');
    r = await send('/uploads/ok.db');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true);
    assert.deepStrictEqual(calls.find(c => c[0] === 'restore')[2], ['afterActivate', 'beforeActivate', 'lifecycle'], 'the restore gets the lifecycle and the session handover');
    r = await send('/uploads/bad.db');
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /not an Epilykos backup/);
    r = await send('/uploads/refused.db');
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'Restore failed, original database restored.', 'a refusal keeps its status, and its detail is not leaked as the message unless it is a preflight');
    r = await send('/uploads/boom.db');
    assert.strictEqual(r.status, 500); assert.strictEqual(r.body.error, 'Restore failed, original database restored.');
    r = await call('GET', '/api/snapshots');
    assert.deepStrictEqual(r.body, [{ name: 'snap-1' }]);
    r = await call('GET', '/api/snapshots/status');
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/api/snapshots/restore/' + encodeURIComponent('snap 1.db'), {});
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.name, 'snap 1.db', 'the name is decoded');
    r = await call('POST', '/api/snapshots/restore/gone', {});
    assert.strictEqual(r.status, 404);
    // The session handover: captured before the swap, put back after.
    const opts = created.restoreSessionOptions({ sessionID: 'sess-1' });
    opts.beforeActivate(); opts.afterActivate();
    assert.deepStrictEqual(calls.filter(c => c[0] === 'capture' || c[0] === 'restored').slice(-2), [['capture', 'sess-1'], ['restored', 'sess-1']]);
    // The server mounts it, and the cloud-backup route shares its helpers.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /require\('\.\/routes\/restore'\)\(\{/); assert.match(src, /app\.use\('\/api', restoreRoutes\.router\)/);
    assert.match(src, /restoreOptions: req => \(\{ lifecycle: restoreLifecycle, \.\.\.restoreSessionOptions\(req\) \}\), restoreFailure/);
    assert.ok(!/app\.(get|post|use)\('\/api\/(restore'|snapshots)/.test(src));
  } finally { server.close(); }
  console.log('ok - restore and snapshot routes: signed-in only, uploads checked, failures answered plainly, session handover bracketed');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
