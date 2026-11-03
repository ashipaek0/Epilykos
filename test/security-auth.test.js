'use strict';
/**
 * test/security-auth.test.js — sign-in hardening from the 3 Nov 2026 audit.
 *
 *  - X-Forwarded-For is believed only from a trusted proxy (TRUST_PROXY), so a
 *    client cannot start a new rate-limit bucket on every request
 *  - all addresses together are limited too
 *  - signing in starts a new session (no session fixation), with a new CSRF token
 *  - sign-out is a POST; the old link no longer signs anyone out
 *  - the password check does not block the server
 *  - changing the password after setup asks for the current one and signs the
 *    other browsers out
 *  - /api/settings refuses the settings that have their own stricter route
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-secauth-'));
process.env.LOG_TO_FILE = 'false';
process.env.SETTINGS_PASSWORD = 'correct-horse-battery';
process.env.ENC_KEY_FILE = path.join(dir, 'key');
process.env.TWO_STEP_FILE = path.join(dir, 'two-step.json');

const { resolveTrustProxy } = require('../modules/trustProxy');
const sessionAuth = require('../modules/sessionAuth');

(async () => {
  // ── TRUST_PROXY ────────────────────────────────────────────────────────
  assert.equal(resolveTrustProxy(undefined), 'loopback', 'default: only this machine');
  assert.equal(resolveTrustProxy(''), 'loopback');
  assert.equal(resolveTrustProxy('true'), 'loopback', '"true" would believe anyone, so it is not taken literally');
  assert.equal(resolveTrustProxy('false'), false);
  assert.equal(resolveTrustProxy('off'), false);
  assert.equal(resolveTrustProxy('2'), 2);
  assert.deepEqual(resolveTrustProxy('172.16.0.0/12, 10.0.0.5'), ['172.16.0.0/12', '10.0.0.5']);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.set\('trust proxy', require\('\.\/modules\/trustProxy'\)\.resolveTrustProxy\(process\.env\.TRUST_PROXY\)\)/);
  assert.doesNotMatch(server, /app\.set\('trust proxy', 1\)/, 'one hop of anyone is gone');
  console.log('ok - TRUST_PROXY: loopback by default, never "anyone"');

  // ── A small app with the real routes, session and CSRF guard ───────────
  const express = require('express');
  const session = require('express-session');
  const { csrfProtection, csrfToken } = require('../modules/csrfProtection');
  const store = new session.MemoryStore();
  store.destroyAllExcept = (sid, cb) => { for (const k of Object.keys(store.sessions)) if (k !== sid) delete store.sessions[k]; cb && cb(null); };
  function makeApp(trust) {
    const app = express();
    app.set('trust proxy', trust);
    app.use(express.json());
    app.use(session({ store, secret: 'test', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto' } }));   // as in server.js: Secure whenever the request is HTTPS
    app.use(csrfProtection);
    app.get('/api/csrf-token', csrfToken);
    app.use('/api', require('../routes/auth'));
    return new Promise(res => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res({ s, base: `http://127.0.0.1:${s.address().port}` })); });
  }
  const client = base => {
    let cookie = '', token = '';
    const call = async (url, { method = 'GET', body, headers = {} } = {}) => {
      const r = await fetch(base + url, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(token ? { 'x-csrf-token': token, 'x-requested-with': 'XMLHttpRequest' } : {}), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const rotated = r.headers.get('x-csrf-token'); if (rotated) token = rotated;
      let data = null; try { data = await r.json(); } catch (_) { /* no body */ }
      return { status: r.status, data, headers: r.headers };
    };
    return { call, get cookie() { return cookie; }, get token() { return token; }, start: async () => { token = (await call('/api/csrf-token')).data.token; } };
  };

  // ── Believe X-Forwarded-For from nobody: rotating it changes nothing ───
  let { s, base } = await makeApp(false);
  let c = client(base); await c.start();
  let codes = [];
  for (let i = 1; i <= 14; i++) codes.push((await c.call('/api/login', { method: 'POST', body: { password: 'wrong' }, headers: { 'x-forwarded-for': `10.9.${i}.${i}` } })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.ok(codes.slice(10).every(code => code === 429), `an 11th attempt is refused whatever X-Forwarded-For says: ${codes}`);
  s.close();
  console.log('ok - a spoofed X-Forwarded-For does not start a new rate-limit bucket');

  // ── From a trusted proxy the header is believed, but all addresses together are limited ──
  sessionAuth.resetLoginThrottle();
  ({ s, base } = await makeApp('loopback'));
  c = client(base); await c.start();
  codes = [];
  for (let i = 1; i <= 36; i++) codes.push((await c.call('/api/login', { method: 'POST', body: { password: 'wrong' }, headers: { 'x-forwarded-for': `10.8.${i}.${i}` } })).status);
  assert.ok(codes.slice(0, 30).every(code => code === 401), 'each client behind the proxy has its own bucket');
  const blocked = await c.call('/api/login', { method: 'POST', body: { password: 'correct-horse-battery' }, headers: { 'x-forwarded-for': '10.8.99.99' } });
  assert.equal(blocked.status, 429, 'past the limit for all addresses together, even a new address is refused');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1, 'and told when to come back');
  console.log('ok - behind a trusted proxy each client has a bucket, and all together are limited');

  // ── Signing in starts a new session ────────────────────────────────────
  sessionAuth.resetLoginThrottle();
  c = client(base); await c.start();
  const before = c.cookie, tokenBefore = c.token;
  assert.equal((await c.call('/api/auth/status')).data.authenticated, false);
  const login = await c.call('/api/login', { method: 'POST', body: { password: 'correct-horse-battery' }, headers: { 'x-forwarded-for': '10.7.0.1' } });
  assert.equal(login.status, 200);
  assert.notEqual(c.cookie, before, 'a new session id after sign-in');
  assert.notEqual(c.token, tokenBefore, 'a new CSRF token with it');
  assert.match(login.headers.get('x-csrf-token') || '', /^[a-f0-9]{64}$/, 'handed to the page in X-CSRF-Token');
  assert.equal((await c.call('/api/auth/status')).data.authenticated, true);
  // A planted id is not signed in by someone else signing in.
  const planted = client(base); await planted.start();
  const plantedCookie = planted.cookie;
  const victim = client(base); victim.call; // the victim presents the planted cookie
  const viaPlanted = await fetch(base + '/api/auth/status', { headers: { cookie: plantedCookie } }).then(r => r.json());
  assert.equal(viaPlanted.authenticated, false);
  const victimLogin = await fetch(base + '/api/login', { method: 'POST', headers: { cookie: plantedCookie, 'content-type': 'application/json', 'x-csrf-token': planted.token, 'x-requested-with': 'XMLHttpRequest', 'x-forwarded-for': '10.7.0.2' }, body: JSON.stringify({ password: 'correct-horse-battery' }) });
  assert.equal(victimLogin.status, 200);
  const after = await fetch(base + '/api/auth/status', { headers: { cookie: plantedCookie } }).then(r => r.json());
  assert.equal(after.authenticated, false, 'the id that was planted before sign-in is not signed in afterwards');
  console.log('ok - signing in starts a new session and CSRF token; a planted session id is not signed in');

  // ── Sign-out is a POST ─────────────────────────────────────────────────
  const get = await c.call('/api/logout');
  assert.equal(get.status, 302, 'the old link redirects');
  assert.equal((await c.call('/api/auth/status')).data.authenticated, true, 'and does not sign anyone out');
  const noToken = await fetch(base + '/api/logout', { method: 'POST', headers: { cookie: c.cookie } });
  assert.equal(noToken.status, 403, 'a POST from another site (no token) is refused');
  const out = await c.call('/api/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  assert.equal((await c.call('/api/auth/status')).data.authenticated, false);
  s.close();
  console.log('ok - sign-out is a POST with the CSRF token; the GET link signs nobody out');

  // ── The password check does not block the server ───────────────────────
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1);
  const started = Date.now();
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(i => sessionAuth.verifyPasswordAsync(i === 1 ? 'correct-horse-battery' : 'wrong' + i)));
  clearInterval(timer);
  assert.deepEqual(results, [true, false, false, false, false, false]);
  assert.ok(ticks >= 5, `other work ran while six passwords were checked (${ticks} ticks in ${Date.now() - started} ms)`);
  assert.equal(await sessionAuth.verifyPasswordAsync('x'.repeat(sessionAuth.MAX_PASSWORD_LENGTH + 1)), false, 'an enormous password is refused outright');
  assert.equal(await sessionAuth.verifyPasswordAsync({ toString() { return 'correct-horse-battery'; } }), false);
  console.log('ok - checking a password does not stop the server, and has a length cap');

  // ── Changing the password after setup ──────────────────────────────────
  for (const f of ['../routes/auth', '../modules/sessionAuth']) delete require.cache[require.resolve(f)];
  const calls = { saved: null, others: null };
  const authFile = require.resolve('../modules/sessionAuth');
  require.cache[authFile] = { id: authFile, filename: authFile, loaded: true, exports: {
    loginLimiter: (req, res, next) => next(), passwordEnvManaged: false, isAuthenticated: (req, res, next) => next(),
    verifyPasswordAsync: async pw => pw === 'the-current-password', setSettingsPassword: pw => { calls.saved = pw; return true; }
  } };
  const config = { setup_wizard_completed: 'true', setup_password_set: 'true' };
  const dbFile = require.resolve('../modules/database');
  const realDb = require.cache[dbFile];
  require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: { ...realDb.exports, getConfig: k => (k in config ? config[k] : null), setConfig: (k, v) => { config[k] = String(v); } } };
  const authRouter = require('../routes/auth');
  const layer = authRouter.stack.find(l => l.route && l.route.path === '/wizard/password' && l.route.methods.post);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const run = async (body, authenticated) => {
    let status = 200, data;
    const session = { authenticated };
    Object.defineProperty(session, 'regenerate', { enumerable: false, value(cb) { for (const k of Object.keys(session)) delete session[k]; cb(null); } });
    const req = { body, session, sessionID: 'new-sid', sessionStore: { destroyAllExcept: (sid, cb) => { calls.others = sid; cb(); } } };
    const res = { status(n) { status = n; return this; }, json(d) { data = d; return this; }, set() { return this; } };
    await handle(req, res);
    return { status, data, session };
  };
  let r = await run({ password: 'a-brand-new-password' }, true);
  assert.equal(r.status, 403, 'a signed-in session alone cannot change the password once setup is done');
  assert.equal(calls.saved, null);
  r = await run({ password: 'a-brand-new-password', currentPassword: 'wrong' }, true);
  assert.equal(r.status, 403);
  assert.equal(calls.saved, null);
  r = await run({ password: 'a-brand-new-password', currentPassword: 'the-current-password' }, true);
  assert.equal(r.status, 200);
  assert.equal(calls.saved, 'a-brand-new-password');
  assert.equal(calls.others, 'new-sid', 'every other browser is signed out');
  assert.equal(r.session.authenticated, true);
  // During first-run setup the wizard may still set it again without the old one.
  config.setup_wizard_completed = ''; calls.saved = null;
  r = await run({ password: 'another-new-password' }, true);
  assert.equal(r.status, 200);
  assert.equal(calls.saved, 'another-new-password');
  console.log('ok - changing the password after setup needs the current one and signs the other browsers out');

  // ── /api/settings keys with their own stricter route ───────────────────
  const { isProtectedKey } = require('../modules/protectedConfig');
  for (const key of ['device_writes_enabled', 'device_writes_expert', 'setup_password_set', 'setup_wizard_completed', 'update_install_auto', 'update_applying', 'two_step_x', 'session_secret', 'encryption_key', 'cloudflare_tunnel', 'tailscale_state', 'remote_x']) {
    assert.equal(isProtectedKey(key), true, `${key} is protected`);
  }
  for (const key of ['dashboard_title', 'solar_latitude', 'savings_rate', 'forecast_enabled', 'log_level', 'ha_devices', 'dongle_config', 'square_corners']) {
    assert.equal(isProtectedKey(key), false, `${key} is an ordinary setting`);
  }
  assert.match(server, /isProtectedKey\(key\)/, '/api/settings uses it');
  console.log('ok - /api/settings refuses the settings that have their own route');

  // ── The page adopts the new token and posts sign-out ───────────────────
  const csrfJs = fs.readFileSync(path.join(__dirname, '..', 'public/js/csrf.js'), 'utf8');
  assert.match(csrfJs, /response\.headers\.get\('X-CSRF-Token'\)/);
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public/js/dashboard.js'), 'utf8');
  assert.match(dash, /fetch\('\/api\/logout', \{ method: 'POST' \}\)/);
  console.log('ok - csrf.js adopts the rotated token; the Sign out link posts');

  fs.rmSync(dir, { recursive: true, force: true });
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
