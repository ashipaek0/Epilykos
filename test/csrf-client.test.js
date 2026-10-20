'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
function fixture() {
  const calls = []; let rejected = false;
  const window = { location: { href: 'https://fixture.local/settings', origin: 'https://fixture.local' }, fetch: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url === '/api/csrf-token' ? { token: 'a'.repeat(64) } : {}), { status: rejected ? 403 : 200, headers: rejected ? { 'X-CSRF-Error': 'token' } : {} });
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/csrf.js'), 'utf8'), { window, Headers, Request, URL, console });
  return { window, calls, rejectToken() { rejected = true; } };
}
test('same-origin unsafe fetches coalesce token bootstrap, preserve headers, and handle Request inputs', async () => {
  const f = fixture();
  await Promise.all([f.window.fetch('/api/login', { method: 'POST' }), f.window.fetch(new Request('https://fixture.local/api/settings', { method: 'PUT', headers: { custom: 'yes' } }))]);
  assert.equal(f.calls.filter(c => c.url === '/api/csrf-token').length, 1);
  assert.equal(f.calls[0].options.credentials, 'same-origin');
  for (const c of f.calls.slice(1)) { assert.equal(c.options.headers.get('X-CSRF-Token'), 'a'.repeat(64)); assert.equal(c.options.headers.get('X-Requested-With'), 'XMLHttpRequest'); }
  assert.equal(f.calls[2].options.headers.get('custom'), 'yes');
  await f.window.fetch('/api/settings', { method: 'POST', body: JSON.stringify({ dongle_config: [{ enabled: true }] }) });
  assert.equal(typeof JSON.parse(f.calls.at(-1).options.body).dongle_config, 'string');
});
test('safe and foreign-origin requests never receive a session token', async () => {
  const f = fixture();
  await f.window.fetch('/api/current');
  await f.window.fetch('https://foreign.local/api/settings', { method: 'POST' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.headers, undefined);
});
test('a rejected token invalidates cache without replaying a mutation', async () => {
  const f = fixture(); f.rejectToken();
  // Bootstrap failure must not send the mutation.
  await assert.rejects(f.window.fetch('/api/settings', { method: 'POST' }));
  assert.equal(f.calls.length, 1);
  const g = fixture(); await g.window.fetch('/api/settings', { method: 'POST' }); g.rejectToken();
  await g.window.fetch('/api/settings', { method: 'POST' });
  assert.equal(g.calls.length, 3);
  await assert.rejects(g.window.fetch('/api/settings', { method: 'POST' }));
  assert.equal(g.calls.length, 4, 'next explicit attempt bootstraps again; failed writes are never replayed');
});
