/**
 * Authentication and Session Management Routes
 *
 * Handles admin login, session logout, authentication status checks,
 * and setup wizard password configuration.
 *
 * @module routes/auth
 */
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
router.post('/wizard/password', loginLimiter, (req, res) => {
  const { password } = req.body;
  const authenticated = !!(req.session && req.session.authenticated);

  if (passwordEnvManaged) {
    if (authenticated) return res.json({ success: true });
    if (setupPending() && typeof password === 'string' && verifyPassword(password)) {
      req.session.authenticated = true;
      return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Enter the SETTINGS_PASSWORD configured on the server' });
  }

  if (!authenticated && !firstPasswordOpen()) {
    logger.warn('Setup wizard: rejected an unauthenticated password change after the first password was set');
    return res.status(403).json({ error: 'The admin password is already set — log in to change it' });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  try {
    setSettingsPassword(password);
    setConfig('setup_password_set', 'true'); // first visitor only: later changes need this session or a login
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
