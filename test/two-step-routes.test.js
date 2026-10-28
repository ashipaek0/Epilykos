'use strict';
/**
 * test/two-step-routes.test.js — signing in and managing two-step sign-in
 * through the real route handlers (routes/auth.js, routes/twoStep.js).
 * Database and password storage are stubbed; the two-step module is real,
 * writing to a temp directory.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-step-routes-'));
process.env.TWO_STEP_FILE = path.join(dir, 'two-step.json');
process.env.ENC_KEY_FILE = path.join(dir, 'encryption-key');

const config = {};
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
  verifyPassword: pw => pw === 'correct horse',
  setSettingsPassword: () => true,
  isAuthenticated: (req, res, next) => next()
});
const twoStep = require('../modules/twoStep');
const authRouter = require('../routes/auth');
const settingsRouter = require('../routes/twoStep');

function handler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
async function call(router, method, routePath, { body = {}, session = {} } = {}) {
  let status = 200, data;
  const res = { status(code) { status = code; return this; }, json(value) { data = value; return this; } };
  await handler(router, method, routePath)({ body, session, hostname: 'box.local' }, res);
  return { status, data, session };
}
const login = (body, session) => call(authRouter, 'post', '/login', { body, session });
const code = (c, session) => call(authRouter, 'post', '/login/code', { body: { code: c }, session });

(async () => {
  // Off: the password alone signs in, as before.
  let r = await login({ password: 'correct horse' }, {});
  assert.equal(r.status, 200);
  assert.equal(r.session.authenticated, true);
  r = await login({ password: 'wrong' }, {});
  assert.equal(r.status, 401);
  console.log('ok - two-step off: the password alone signs in');

  // Turn it on through the settings routes.
  r = await call(settingsRouter, 'get', '/status');
  assert.equal(r.data.enabled, false);
  const session = { authenticated: true };
  r = await call(settingsRouter, 'post', '/begin', { body: { password: 'nope' }, session });
  assert.equal(r.status, 403);
  assert.equal(session.twoStepSetup, undefined);
  r = await call(settingsRouter, 'post', '/begin', { body: { password: 'correct horse' }, session });
  assert.equal(r.status, 200);
  const { secret } = r.data;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.ok(r.data.uri.includes(secret) && r.data.uri.includes('box.local'));
  assert.match(r.data.qr, /^data:image\/png;base64,/);
  assert.equal(twoStep.isEnabled(), false, 'nothing is saved before a code proves the app has it');
  r = await call(settingsRouter, 'post', '/enable', { body: { code: '000000' }, session });
  assert.equal(r.status, 400);
  assert.ok(r.data.serverTime);
  assert.equal(twoStep.isEnabled(), false);
  r = await call(settingsRouter, 'post', '/enable', { body: { code: twoStep.codeAt(secret) }, session });
  assert.equal(r.status, 200);
  const recovery = r.data.recoveryCodes;
  assert.equal(recovery.length, 10);
  assert.equal(session.twoStepSetup, undefined);
  assert.equal(twoStep.isEnabled(), true);
  r = await call(settingsRouter, 'post', '/begin', { body: { password: 'correct horse' }, session });
  assert.equal(r.status, 409);
  r = await call(settingsRouter, 'post', '/enable', { body: { code: '123456' }, session: {} });
  assert.equal(r.status, 400, 'no setup in progress');
  console.log('ok - setup: password, QR code, a code from the app, then recovery codes once');

  // On: the password starts the sign-in, the code finishes it.
  const s1 = {};
  r = await login({ password: 'correct horse' }, s1);
  assert.equal(r.status, 401);
  assert.equal(r.data.needsCode, true);
  assert.equal(s1.authenticated, undefined);
  assert.ok(s1.twoStepPending);
  r = await call(authRouter, 'get', '/auth/status', { session: s1 });
  assert.equal(r.data.authenticated, false);
  console.log('ok - two-step on: the password alone does not sign in');

  r = await code('000000', s1);
  assert.equal(r.status, 401);
  assert.ok(r.data.serverTime, 'a failed code shows the box clock');
  assert.equal(s1.authenticated, undefined);
  // Sign in with the next step's code (the enable code was already used).
  const later = Date.now() + 30000;
  const realNow = Date.now;
  Date.now = () => later;
  r = await code(twoStep.codeAt(secret, later), s1);
  assert.equal(r.status, 200);
  assert.equal(s1.authenticated, true);
  assert.equal(s1.twoStepPending, undefined);
  console.log('ok - a right code signs in; a wrong one shows the box clock');

  // The same code cannot sign in a second session.
  const s2 = {};
  await login({ password: 'correct horse' }, s2);
  r = await code(twoStep.codeAt(secret, later), s2);
  assert.equal(r.status, 401, 'a used code is refused');
  Date.now = realNow;
  console.log('ok - a code that signed in once cannot sign in again');

  // Five wrong codes end the attempt.
  const s3 = {};
  await login({ password: 'correct horse' }, s3);
  for (let i = 0; i < 4; i++) { r = await code('111111', s3); assert.equal(r.status, 401); assert.equal(r.data.restart, undefined); }
  r = await code('111111', s3);
  assert.equal(r.data.restart, true);
  assert.equal(s3.twoStepPending, undefined);
  r = await code(recovery[0], s3);
  assert.equal(r.data.restart, true, 'after the lock-out even a good code needs the password first');
  assert.equal(s3.authenticated, undefined);
  console.log('ok - five wrong codes force the password again');

  // No password step, or an old one: refused.
  r = await code(recovery[0], {});
  assert.equal(r.status, 401);
  assert.equal(r.data.restart, true);
  const stale = { twoStepPending: { at: Date.now() - 6 * 60 * 1000, tries: 0 } };
  r = await code(recovery[0], stale);
  assert.equal(r.data.restart, true);
  assert.equal(stale.authenticated, undefined);
  console.log('ok - a code without a recent password step is refused');

  // A recovery code signs in once.
  const s4 = {};
  await login({ password: 'correct horse' }, s4);
  r = await code(recovery[0], s4);
  assert.equal(r.status, 200);
  assert.equal(r.data.usedRecovery, true);
  assert.equal(r.data.recoveryLeft, 9);
  const s5 = {};
  await login({ password: 'correct horse' }, s5);
  r = await code(recovery[0], s5);
  assert.equal(r.status, 401);
  console.log('ok - a recovery code signs in once');

  // The setup wizard is not a way round it.
  r = await call(authRouter, 'post', '/wizard/password', { body: { password: 'new password' }, session: {} });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.includes('Two-step'), true);
  console.log('ok - the first-run wizard cannot sign in around two-step');

  // Managing it: new recovery codes and turning it off need the password and a code.
  r = await call(settingsRouter, 'post', '/recovery', { body: { password: 'correct horse', code: 'AAAAA-AAAAA' } });
  assert.equal(r.status, 403);
  r = await call(settingsRouter, 'post', '/recovery', { body: { password: 'wrong', code: recovery[1] } });
  assert.equal(r.status, 403);
  r = await call(settingsRouter, 'post', '/recovery', { body: { password: 'correct horse', code: recovery[1] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.recoveryCodes.length, 10);
  const fresh = r.data.recoveryCodes;
  r = await call(settingsRouter, 'post', '/disable', { body: { password: 'correct horse', code: '000000' } });
  assert.equal(r.status, 403);
  assert.equal(twoStep.isEnabled(), true);
  r = await call(settingsRouter, 'post', '/disable', { body: { password: 'wrong', code: fresh[0] } });
  assert.equal(r.status, 403);
  assert.equal(twoStep.isEnabled(), true);
  r = await call(settingsRouter, 'post', '/disable', { body: { password: 'correct horse', code: fresh[0] } });
  assert.equal(r.status, 200);
  assert.equal(twoStep.isEnabled(), false);
  r = await login({ password: 'correct horse' }, {});
  assert.equal(r.status, 200);
  console.log('ok - new codes and turning it off need the password and a code; off means the password alone again');

  fs.rmSync(dir, { recursive: true, force: true });
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
