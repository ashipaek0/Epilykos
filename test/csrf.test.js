'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { csrfProtection, csrfToken } = require('../modules/csrfProtection');

test('session token protects login, settings and binary uploads; only exact webhook routes bypass it', async () => {
  const app = express();
  app.use(session({ secret: 'csrf-fixture', resave: false, saveUninitialized: false, cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax' } }));
  app.use(csrfProtection);
  app.get('/api/csrf-token', csrfToken);
  let mutations = 0;
  app.post(['/api/login', '/api/settings', '/api/pvoutput/webhook', '/api/pvoutput/webhook/:token', '/api/pvoutput/webhook-extra'], (_q, s) => { mutations++; s.sendStatus(200); });
  app.put('/api/chunks', express.raw({ type: 'application/octet-stream' }), (q, s) => { assert.equal(q.body.toString(), 'binary'); mutations++; s.sendStatus(200); });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function bootstrap() {
    const r = await fetch(base + '/api/csrf-token');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    return { cookie: r.headers.get('set-cookie').split(';')[0], token: (await r.json()).token };
  }
  try {
    const a = await bootstrap(), b = await bootstrap();
    assert.match(a.token, /^[a-f0-9]{64}$/); assert.notEqual(a.token, b.token);
    const headers = { cookie: a.cookie, 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': a.token };
    for (const path of ['/api/login', '/api/settings']) {
      for (const extra of [{ 'x-csrf-token': '' }, { 'x-csrf-token': b.token }, { 'x-requested-with': '' }, { origin: 'https://evil.example' }, { origin: 'null' }]) {
        assert.equal((await fetch(base + path, { method: 'POST', headers: { ...headers, ...extra } })).status, 403);
      }
      assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 200);
    }
    assert.equal((await fetch(base + '/api/chunks', { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: 'binary' })).status, 200);
    assert.equal((await fetch(base + '/api/pvoutput/webhook', { method: 'POST' })).status, 200);
    assert.equal((await fetch(base + '/api/pvoutput/webhook/token?query=1', { method: 'POST' })).status, 200);
    assert.equal((await fetch(base + '/api/pvoutput/webhook-extra', { method: 'POST' })).status, 403);
    assert.equal(mutations, 5, 'rejected requests never reach a state-changing handler');
    const again = await fetch(base + '/api/csrf-token', { headers: { cookie: a.cookie } });
    assert.equal((await again.json()).token, a.token, 'token remains stable for concurrent requests and long uploads');
  } finally { await new Promise(r => server.close(r)); }
});
