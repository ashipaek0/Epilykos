'use strict';
const checks = require('./_checks');
// Settings → Updates, EpilykosOS card routes (OS update design §10.2) against
// a fake epilykos-hostd: the host's job view becomes host.os; install sends
// exactly the sequence/SHA-256 the last check offered (a stale page gets a
// 409) with a request ID and never the password; restart and discard need
// the password and name the job; an older host reports unsupported; Docker
// installs have no EpilykosOS card.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-os-updates-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.SETTINGS_PASSWORD;
const express = require('express');
const database = require('../modules/database');
database.initializeDatabase();
const { setSettingsPassword } = require('../modules/sessionAuth');
setSettingsPassword('correct horse battery');

const JOB = '11111111-2222-4333-8444-555555555555';
const SHA = 'a'.repeat(64);
const seen = [];
let job = null, oldHost = false;
const candidate = { sequence: 12, version: '0.7', size: 412345678, sha256: SHA, notes_url: 'https://example.invalid/notes' };
const view = () => ({ supported: true, version: '0.6', sequence: 11, channel: 'dev', guard: job ? 'active' : 'idle', job });
const sock = path.join(tmp, 'host.sock');
const host = net.createServer(conn => {
  let buf = '';
  conn.on('data', d => {
    buf += d;
    if (!buf.includes('\n')) return;
    const req = JSON.parse(buf.slice(0, buf.indexOf('\n')));
    seen.push(req);
    let reply;
    if (oldHost && req.action.startsWith('os_')) reply = { ok: false, error: 'unknown action' };
    else if (req.action === 'os_status') reply = { ok: true, os: view() };
    else if (req.action === 'os_check') reply = { ok: true, os: { ...view(), available: true, candidate, blockers: [] } };
    else if (req.action === 'os_install') {
      job = { id: JOB, request_id: req.request_id, state: 'downloading', sequence: 12, version: '0.7',
              progress: { phase: 'downloading', bytes: 125829120, total: 412345678 }, error: null, created_at: '2026-10-23T10:00:00Z' };
      reply = { ok: true, os: view() };
    } else if (req.action === 'os_restart' && (!job || req.job !== job.id || job.state !== 'ready')) reply = { ok: false, error: 'There is no OS update ready to finish' };
    else if (['os_cancel', 'os_restart', 'os_discard', 'os_dismiss'].includes(req.action)) reply = { ok: true, os: view() };
    else reply = { ok: true, app: { state: 'idle' }, os: view() };
    conn.end(JSON.stringify(reply) + '\n');
  });
});

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  await new Promise(r => host.listen(sock, r));
  const app = express();
  app.use(express.json());
  app.use('/api/updates', require('../routes/updates').router());
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const events = require('../modules/notifications/events');
  const sent = [];
  events.emitEvent = (type, fields) => sent.push({ type, fields });

  // Docker / development: no socket, no card, no OS actions.
  delete process.env.EPILYKOS_HOST_SOCKET;
  let r = await request(server, 'GET', '/api/updates');
  assert.equal(r.body.os, null);
  r = await request(server, 'POST', '/api/updates/os/check', {});
  assert.equal(r.status, 404);
  console.log('ok - off EpilykosOS: no EpilykosOS card and no OS actions');

  process.env.EPILYKOS_HOST_SOCKET = sock;
  r = await request(server, 'GET', '/api/updates');
  assert.equal(r.body.method.kind, 'epilykos-os');
  assert.deepEqual([r.body.os.version, r.body.os.supported, r.body.os.available, r.body.os.job], ['0.6', true, false, null]);

  r = await request(server, 'POST', '/api/updates/os/check', {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.os.available, r.body.os.latest_version, r.body.os.latest_sequence], [true, '0.7', 12]);
  assert.equal(r.body.os.latest.sha256, SHA);
  assert.equal(sent.length, 1); assert.match(sent[0].fields.message, /EpilykosOS 0\.7 is ready/);
  await request(server, 'POST', '/api/updates/os/check', {});
  assert.equal(sent.length, 1, 'one notification per system release');
  console.log('ok - check: host.os with the latest signed system, notified once');

  r = await request(server, 'POST', '/api/updates/os/install', { sequence: 12, sha256: SHA, request_id: 'req-12345678', password: 'wrong' });
  assert.equal(r.status, 403);
  r = await request(server, 'POST', '/api/updates/os/install', { sequence: 12, sha256: 'b'.repeat(64), request_id: 'req-12345678', password: 'correct horse battery' });
  assert.equal(r.status, 409, 'a stale page cannot install something else');
  r = await request(server, 'POST', '/api/updates/os/install', { sequence: 13, sha256: SHA, request_id: 'req-12345678', password: 'correct horse battery' });
  assert.equal(r.status, 409);
  assert.ok(!seen.some(q => q.action === 'os_install'), 'nothing reached the host');
  r = await request(server, 'POST', '/api/updates/os/install', { sequence: 12, sha256: SHA, request_id: 'req-12345678', password: 'correct horse battery' });
  assert.equal(r.status, 200);
  const sentInstall = seen.find(q => q.action === 'os_install');
  assert.deepEqual(sentInstall, { action: 'os_install', sequence: 12, sha256: SHA, request_id: 'req-12345678' }, 'no password to the host');
  assert.deepEqual([r.body.os.job.state, r.body.os.job.bytes, r.body.os.job.total], ['downloading', 125829120, 412345678]);
  console.log('ok - install: password checked here, exact offered package and request ID to the host');

  r = await request(server, 'POST', '/api/updates/os/restart', { job: JOB, password: 'wrong' });
  assert.equal(r.status, 403);
  r = await request(server, 'POST', '/api/updates/os/restart', { job: 'not-a-job', password: 'correct horse battery' });
  assert.equal(r.status, 400);
  r = await request(server, 'POST', '/api/updates/os/restart', { job: JOB, password: 'correct horse battery' });
  assert.equal(r.status, 400, 'the host refuses a job that is not ready');
  assert.match(r.body.error, /no OS update ready/);
  job.state = 'ready';
  r = await request(server, 'POST', '/api/updates/os/restart', { job: JOB, password: 'correct horse battery' });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.filter(q => q.action === 'os_restart').pop(), { action: 'os_restart', job: JOB });
  r = await request(server, 'POST', '/api/updates/os/discard', { job: JOB });
  assert.equal(r.status, 403, 'discard needs the password too');
  r = await request(server, 'POST', '/api/updates/os/cancel', { job: JOB });
  assert.equal(r.status, 200);
  console.log('ok - restart/discard need the password and name the job; host refusals are relayed');

  job.state = 'rolled_back'; job.error = 'The new version did not start properly'; job.updated_at = '2026-10-23T11:00:00Z';
  r = await request(server, 'GET', '/api/updates');
  assert.equal(r.body.os.job, null);
  assert.deepEqual([r.body.os.last_result.outcome, r.body.os.last_result.version, r.body.os.last_result.reason],
    ['rolled_back', '0.7', 'The new version did not start properly']);
  r = await request(server, 'POST', '/api/updates/os/dismiss', { job: JOB });
  assert.equal(r.status, 200);
  console.log('ok - a finished job is a result until dismissed');

  oldHost = true;
  r = await request(server, 'GET', '/api/updates');
  assert.equal(r.body.os.supported, false);
  assert.match(r.body.os.unsupported_reason, /cannot install system updates/);
  r = await request(server, 'POST', '/api/updates/os/check', {});
  assert.equal(r.status, 409);
  r = await request(server, 'POST', '/api/updates/apply', { target: 'os', password: 'correct horse battery' });
  assert.notEqual(r.status, 200, 'the old update_apply(os) path still refuses');
  console.log('ok - an older EpilykosOS: unsupported, nothing offered');

  server.close(); host.close();
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
