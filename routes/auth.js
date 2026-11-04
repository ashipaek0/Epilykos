/**
 * Authentication and Session Management Routes
 *
 * Handles admin login, session logout, authentication status checks,
 * and setup wizard password configuration.
 *
 * @module routes/auth
 */
const crypto = require('crypto');
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, setConfig } = require('../modules/database');
const { loginLimiter, passwordEnvManaged, verifyPasswordAsync, setSettingsPassword, isAuthenticated } = require('../modules/sessionAuth');
const twoStep = require('../modules/twoStep');

const router = express.Router();

// Admin login. With two-step sign-in on, the password only starts the
// sign-in: the session is signed in by /login/code, within five minutes and
// five tries.
const CODE_WINDOW_MS = 5 * 60 * 1000;
const CODE_TRIES = 5;
// The shortest admin password the wizard accepts; remote access asks the same (routes/remote.js).
const MIN_PASSWORD_LENGTH = 12;

/**
 * Sign this request's session in under a new session id. The id a visitor had
 * before signing in must not be the one that is signed in: someone who planted
 * it (a link, a cookie set from another page) would otherwise share the
 * session. The CSRF token changes with it; the reply carries the new one in
 * X-CSRF-Token and js/csrf.js uses it from then on.
 */
function signIn(req, res, done) {
  req.session.regenerate(err => {
    if (err) return done(err);
    const token = crypto.randomBytes(32).toString('hex');
    req.session.authenticated = true;
    req.session.csrfToken = token;
    res.set('X-CSRF-Token', token);
    done(null);
  });
}

function signInFailed(res, err) {
  logger.error('Could not start the session:', err.message);
  res.status(500).json({ error: 'Could not sign in. Try again.' });
}

router.post('/login', loginLimiter, async (req, res) => {
  const { password } = req.body || {};
  if (password && await verifyPasswordAsync(password)) {
    if (twoStep.isEnabled()) {
      req.session.twoStepPending = { at: Date.now(), tries: 0 };
      logger.info('Password accepted; waiting for the two-step code');
      return res.status(401).json({ needsCode: true, error: 'Enter the code from your authenticator app' });
    }
    return signIn(req, res, err => {
      if (err) return signInFailed(res, err);
      logger.info('User logged in successfully');
      res.json({ success: true });
    });
  }
  logger.warn('Failed login attempt');
  res.status(401).json({ error: 'Invalid password' });
});

// Second step: the app's 6 digits, or a recovery code.
router.post('/login/code', loginLimiter, (req, res) => {
  const pending = req.session && req.session.twoStepPending;
  if (!pending || Date.now() - pending.at > CODE_WINDOW_MS) {
    if (req.session) delete req.session.twoStepPending;
    return res.status(401).json({ restart: true, error: 'That sign-in timed out. Enter your password again.' });
  }
  const result = twoStep.check(req.body && req.body.code);
  if (result.ok) {
    return signIn(req, res, err => {
      if (err) return signInFailed(res, err);
      logger.info(result.kind === 'recovery'
        ? `User logged in with a recovery code (${result.recoveryLeft} left)`
        : 'User logged in successfully (two-step)');
      res.json({ success: true, usedRecovery: result.kind === 'recovery', recoveryLeft: result.recoveryLeft });
    });
  }
  logger.warn(`Failed two-step code (${result.reason})`);
  pending.tries += 1;
  const serverTime = new Date().toISOString();
  if (pending.tries >= CODE_TRIES) {
    delete req.session.twoStepPending;
    return res.status(401).json({ restart: true, serverTime, error: 'Too many wrong codes. Enter your password again.' });
  }
  const error = result.reason === 'secret-unreadable'
    ? 'This box cannot check app codes (its encryption key changed). Use a recovery code.'
    : result.reason === 'broken'
      ? 'Two-step sign-in is damaged on this box. Reset it with the password reset, or see the README.'
      : 'That code did not work.';
  res.status(401).json({ error, serverTime, reason: result.reason });
});

// Admin logout. A POST (with the CSRF token), so another site cannot sign
// someone out with a link or an image. The page's Sign out link posts here
// (public/js/dashboard.js).
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    logger.info('User logged out');
    res.json({ success: true });
  });
});
// The old link, kept so a bookmark lands somewhere sensible; it no longer signs anyone out.
router.get('/logout', (req, res) => res.redirect('/'));

// Auth status (public, returns session state)
router.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// Setup wizard status
router.get('/wizard/status', (req, res) => {
  try {
    const completed = getConfig('setup_wizard_completed') === 'true';
    const keys = ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices', 'modbus_devices', 'bms_devices', 'external_sources'];
    let hasDataSource = false;
    for (const k of keys) {
      const v = JSON.parse(getConfig(k) || '[]');
      if (Array.isArray(v) && v.length > 0) { hasDataSource = true; break; }
    }
    const passwordSet = getConfig('setup_password_set') === 'true';
    res.json({ needsSetup: !completed, completed, hasDataSource, passwordEnvManaged, passwordSet });
  } catch (err) {
    logger.error('Error in /api/wizard/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── First-run password ─────────────────────────────────────────────
// The first visitor sets the admin password: an unauthenticated caller may
// set it once, while setup is pending and before anyone else has. After
// that, changing it needs a logged-in session. With SETTINGS_PASSWORD set,
// the wizard instead asks for that password.
function setupPending() {
  return getConfig('setup_wizard_completed') !== 'true';
}

function firstPasswordOpen() {
  return setupPending() && getConfig('setup_password_set') !== 'true';
}

// Tells the wizard whether it may set the first password.
router.get('/wizard/password', (req, res) => {
  const authenticated = !!(req.session && req.session.authenticated);
  if (!firstPasswordOpen() && !authenticated) {
    return res.status(403).json({ error: 'Setup already complete' });
  }
  res.json({ envManaged: passwordEnvManaged });
});

// Set the first admin password (or, env-managed, prove the env password).
router.post('/wizard/password', loginLimiter, async (req, res) => {
  const { password, currentPassword } = req.body || {};
  const authenticated = !!(req.session && req.session.authenticated);

  if (passwordEnvManaged) {
    if (authenticated) return res.json({ success: true });
    if (setupPending() && typeof password === 'string' && await verifyPasswordAsync(password)) {
      if (twoStep.isEnabled()) return res.status(403).json({ error: 'Two-step sign-in is on: sign in from the login page' });
      return signIn(req, res, err => (err ? signInFailed(res, err) : res.json({ success: true })));
    }
    return res.status(401).json({ error: 'Enter the SETTINGS_PASSWORD configured on the server' });
  }

  if (!authenticated && twoStep.isEnabled()) {
    return res.status(403).json({ error: 'Two-step sign-in is on: sign in from the login page' });
  }
  if (!authenticated && !firstPasswordOpen()) {
    logger.warn('Setup wizard: rejected an unauthenticated password change after the first password was set');
    return res.status(403).json({ error: 'The admin password is already set — log in to change it' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  // Once setup is finished, changing the password proves the current one, so a
  // stolen session cannot take the account over for good. (During first-run
  // setup the wizard may set it again.)
  const isChange = authenticated && !setupPending();
  if (isChange && !(typeof currentPassword === 'string' && await verifyPasswordAsync(currentPassword))) {
    logger.warn('Password change refused: the current password was missing or wrong');
    return res.status(403).json({ error: 'Enter your current password to change it' });
  }
  try {
    setSettingsPassword(password);
    setConfig('setup_password_set', 'true'); // first visitor only: later changes need this session or a login
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
  const others = authenticated ? req.sessionID : null;
  signIn(req, res, err => {
    if (err) return signInFailed(res, err);
    // Every other signed-in browser is signed out: they may belong to whoever the change is against.
    if (others && req.sessionStore && typeof req.sessionStore.destroyAllExcept === 'function') {
      req.sessionStore.destroyAllExcept(req.sessionID, () => {});
    }
    res.json({ success: true });
  });
});

// Complete setup wizard
router.post('/wizard/complete', isAuthenticated, (req, res) => {
  setConfig('setup_wizard_completed', 'true');
  res.json({ success: true });
});

module.exports = router;
