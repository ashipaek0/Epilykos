'use strict';
/**
 * test/backup-passphrase-ui.test.js — the passphrase in the Settings → Backup
 * and restore page: the server holds it for one download, the restore client
 * asks for it when a restore is waiting and asks again after a wrong one, and
 * the page markup is a toggle switch with the right wiring.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), http = require('node:http');
const express = require('express');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

async function serve(clock) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.sessionID = req.headers['x-session'] || 'one'; next(); });
  app.use('/api/backup', require('../routes/backup')((res, options) => { calls.push(options || null); res.json({ sent: true }); }, { now: () => clock.t }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body, session) => fetch(base + '/api/backup/protect', { method: 'POST', headers: { 'content-type': 'application/json', ...(session ? { 'x-session': session } : {}) }, body: JSON.stringify(body) });
  const get = (query, session) => fetch(base + '/api/backup' + query, { headers: session ? { 'x-session': session } : {} });
  return { calls, post, get, close: () => new Promise(resolve => server.close(resolve)) };
}

test('a passphrase is held for one protected download and then forgotten', async () => {
  const clock = { t: 1000 }, s = await serve(clock);
  try {
    assert.equal((await s.get('')).status, 200);
    assert.deepEqual(s.calls, [null], 'a plain download passes no passphrase');
    assert.equal((await s.post({ passphrase: 'short' })).status, 400);
    assert.equal((await s.post({})).status, 400);
    assert.equal((await s.get('?protect=1')).status, 400, 'nothing was held');
    assert.equal((await s.post({ passphrase: 'a long passphrase' })).status, 200);
    assert.equal((await s.get('?protect=1', 'someone-else')).status, 400, 'held for the session that sent it');
    assert.equal((await s.get('?protect=1')).status, 200);
    assert.deepEqual(s.calls[1], { passphrase: 'a long passphrase' });
    assert.equal((await s.get('?protect=1')).status, 400, 'used once');
    await s.post({ passphrase: 'a long passphrase' });
    clock.t += 3 * 60 * 1000;
    const late = await s.get('?protect=1');
    assert.equal(late.status, 400, 'expires after two minutes');
    assert.match((await late.json()).error, /expired|not received/);
    assert.equal(s.calls.length, 2);
  } finally { await s.close(); }
});

// The restore client, with a scripted server.
function clientFixture(answers) {
  const requests = [], timers = [];
  const options = { status: {}, progress: { removeAttribute() {} }, cancel: { addEventListener() {} }, row: {}, restore: {}, backup: {}, onSelected() {}, asked: [],
    askPassphrase(ctx) { options.asked.push(ctx); return Promise.resolve(answers.shift()); } };
  const waiting = { id: 'job', phase: 'passphrase', bytes: 10, received: 10, chunkBytes: 4 };
  const window = { EpilykosCsrf: { token: async () => 't', invalidate() {} }, addEventListener() {}, removeEventListener() {},
    fetch: async (url, init) => {
      requests.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      if (/\/passphrase$/.test(url)) {
        const sent = JSON.parse(init.body);
        if (sent.passphrase === 'wrong one!!') return { ok: false, status: 422, json: async () => ({ error: 'That passphrase is not right.' }) };
        return { ok: true, json: async () => ({ ...waiting, phase: 'preparing' }) };
      }
      if (/\/cancel$/.test(url)) return { ok: true, json: async () => ({ ...waiting, phase: 'cancelled' }) };
      return { ok: true, json: async () => ({ status: waiting }) };
    } };
  vm.runInNewContext(read('public/js/restore-upload.js'), { window, setTimeout(cb, ms) { timers.push({ cb, ms }); return timers.length; }, clearTimeout() {} });
  return { client: window.EpilykosRestoreUploads.connect(options), options, requests };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('a waiting restore asks for the passphrase, asks again after a wrong one, then goes on', async () => {
  const f = clientFixture([{ passphrase: 'wrong one!!' }, { passphrase: 'right one!!' }]);
  await f.client.refresh(); await settle();
  assert.equal(f.options.asked.length, 2, 'one dialog at a time, a second after the refusal');
  assert.equal(f.options.asked[0].error, '');
  assert.match(f.options.asked[1].error, /not right/);
  const sent = f.requests.filter(r => /passphrase$/.test(r.url));
  assert.deepEqual(sent.map(r => r.body.passphrase), ['wrong one!!', 'right one!!']);
  assert.match(f.options.status.textContent, /Validating/);
  f.client.dispose();
});

test('"restore without saved passwords" is sent as skip, and closing the dialog cancels the restore', async () => {
  const skip = clientFixture([{ skip: true }]);
  await skip.client.refresh(); await settle();
  assert.deepEqual(skip.requests.filter(r => /passphrase$/.test(r.url)).map(r => r.body), [{ skip: true }]);
  skip.client.dispose();
  const stop = clientFixture([null]);
  await stop.client.refresh(); await settle();
  assert.ok(stop.requests.some(r => /\/cancel$/.test(r.url)));
  assert.equal(stop.requests.filter(r => /passphrase$/.test(r.url)).length, 0);
  assert.match(stop.options.status.textContent, /cancelled/i);
  stop.client.dispose();
});

test('the Backup page has a toggle switch with two fields, and the shell wires both directions', () => {
  const page = read('public/settings.html'), shell = read('public/js/settings-shell.js');
  assert.match(page, /<input type="checkbox" id="backup-protect">/);
  assert.match(page, /id="backup-passphrase-fields" hidden/);
  assert.match(page, /id="backup-pass"[^>]*type="password"|type="password" id="backup-pass"/);
  assert.doesNotMatch(page.slice(page.indexOf('id="backup-protect"') - 200, page.indexOf('id="backup-protect"') + 900), /type="radio"/);
  assert.match(page, /settings-shell\.js\?v=10/);
  assert.match(page, /restore-upload\.js\?v=2/);
  assert.match(shell, /'\/api\/backup\/protect'/);
  assert.match(shell, /\/api\/backup\?protect=1/);
  assert.match(shell, /askPassphrase: askRestorePassphrase/);
  assert.doesNotMatch(shell, /protect=1&|passphrase=/, 'the passphrase is never put in an address');
  new Function(shell); new Function(read('public/js/restore-upload.js'));
  assert.match(read('server.js'), /app\.use\('\/api\/backup', require\('\.\/routes\/backup'\)\(backupDatabase\)\)/);
});
