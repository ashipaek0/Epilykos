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
const { loginLimiter, passwordEnvManaged, verifyPassword, setSettingsPassword, isAuthenticated } = require('../modules/sessionAuth');

const router = express.Router();

// Admin login
router.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password && verifyPassword(password)) {
    req.session.authenticated = true;
    logger.info('User logged in successfully');
    return res.json({ success: true });
  }
  logger.warn('Failed login attempt');
  res.status(401).json({ error: 'Invalid password' });
});

// Admin logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  logger.info('User logged out');
  res.redirect('/');
});

// Auth status (public, returns session state)
router.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// Setup wizard status
router.get('/wizard/status', (req, res) => {
  try {
    const completed = getConfig('setup_wizard_completed') === 'true';
    const keys = ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices'];
    let hasDataSource = false;
    for (const k of keys) {
      const v = JSON.parse(getConfig(k) || '[]');
      if (Array.isArray(v) && v.length > 0) { hasDataSource = true; break; }
    }
    res.json({ needsSetup: !completed, completed, hasDataSource, passwordEnvManaged });
  } catch (err) {
    logger.error('Error in /api/wizard/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── First-run password ─────────────────────────────────────────────
// Before setup is complete, an unauthenticated caller may set the first
// password only with the one-time setup code printed to the server log (so
// whoever reaches the page first on the network cannot claim the instance).
// With SETTINGS_PASSWORD set, the wizard instead asks for that password.
let setupCode = null;

function setupPending() {
  return getConfig('setup_wizard_completed') !== 'true';
}

/** Generate (once per process) and log the setup code while setup is pending. */
function announceSetupCode() {
  if (passwordEnvManaged || !setupPending()) return null;
  if (!setupCode) {
    setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    logger.warn(`First-run setup code: ${setupCode} — enter it in the setup wizard at /setup to set the admin password.`);
  }
  return setupCode;
}

function codeMatches(input) {
  if (!setupCode || typeof input !== 'string') return false;
  const a = Buffer.from(input.trim().toUpperCase());
  const b = Buffer.from(setupCode);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Tells the wizard which proof it must collect before the first password.
router.get('/wizard/password', (req, res) => {
  const authenticated = !!(req.session && req.session.authenticated);
  if (!setupPending() && !authenticated) {
    return res.status(403).json({ error: 'Setup already complete' });
  }
  res.json({
    envManaged: passwordEnvManaged,
    setupCodeRequired: !passwordEnvManaged && !authenticated
  });
});

// Set the first admin password (or, env-managed, prove the env password).
router.post('/wizard/password', loginLimiter, (req, res) => {
  const { password, setup_code: code } = req.body;
  const authenticated = !!(req.session && req.session.authenticated);

  if (passwordEnvManaged) {
    if (authenticated) return res.json({ success: true });
    if (setupPending() && typeof password === 'string' && verifyPassword(password)) {
      req.session.authenticated = true;
      return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Enter the SETTINGS_PASSWORD configured on the server' });
  }

  if (!authenticated) {
    if (!setupPending()) {
      return res.status(403).json({ error: 'Setup already complete — log in to change the password' });
    }
    announceSetupCode();
    if (!codeMatches(code)) {
      logger.warn('Setup wizard: rejected password change with a missing or wrong setup code');
      return res.status(401).json({ error: 'Setup code is missing or incorrect — find it in the server log' });
    }
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  try {
    setSettingsPassword(password);
    setupCode = null; // single use: later changes need this session or a login
    req.session.authenticated = true;
    return res.json({ success: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// Complete setup wizard
router.post('/wizard/complete', isAuthenticated, (req, res) => {
  setConfig('setup_wizard_completed', 'true');
  res.json({ success: true });
});

module.exports = router;
module.exports.announceSetupCode = announceSetupCode;
