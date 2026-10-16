'use strict';
/**
 * test/first-run-password.test.js — the first visitor sets the admin password.
 *
 * No setup code: while setup is pending, an unauthenticated caller may set
 * the password once; after that only a logged-in session can change it.
 * Database and password storage are stubbed so nothing touches data/.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const path = require('path');

const config = {};
let savedPassword = null;
function stub(rel, exports) {
  const file = require.resolve(path.join('..', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('modules/database', {
  getConfig: key => (key in config ? config[key] : null),
  setConfig: (key, value) => { config[key] = String(value); }
});
stub('modules/sessionAuth', {
  loginLimiter: (req, res, next) => next(),
  passwordEnvManaged: false,
  verifyPassword: pw => pw === savedPassword,
  setSettingsPassword: pw => { savedPassword = pw; return true; },
  isAuthenticated: (req, res, next) => next()
});
const router = require('../routes/auth');

function handler(method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
async function call(method, routePath, { body = {}, session = {} } = {}) {
  let status = 200, data;
  const res = { status(code) { status = code; return this; }, json(value) { data = value; return this; } };
  await handler(method, routePath)({ body, session }, res);
  return { status, data, session };
}

(async () => {
  let r = await call('get', '/wizard/password');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { envManaged: false });
  r = await call('get', '/wizard/status');
  assert.equal(r.data.passwordSet, false);
  console.log('ok - fresh install: the wizard may set the password, no setup code asked for');

  r = await call('post', '/wizard/password', { body: { password: 'first-visitor' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.session.authenticated, true);
  assert.equal(savedPassword, 'first-visitor');
  r = await call('get', '/wizard/status');
  assert.equal(r.data.passwordSet, true);
  console.log('ok - first visitor sets the password and is signed in');

  r = await call('post', '/wizard/password', { body: { password: 'second-visitor' } });
  assert.equal(r.status, 403);
  assert.equal(savedPassword, 'first-visitor');
  r = await call('get', '/wizard/password');
  assert.equal(r.status, 403);
  console.log('ok - a second, unauthenticated visitor cannot replace it during setup');

  r = await call('post', '/wizard/password', { body: { password: 'changed' }, session: { authenticated: true } });
  assert.equal(r.status, 200);
  assert.equal(savedPassword, 'changed');
  console.log('ok - a signed-in session can still change it');

  r = await call('post', '/wizard/password', { body: { password: 'abc' }, session: { authenticated: true } });
  assert.equal(r.status, 400);
  console.log('ok - short passwords are refused');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
