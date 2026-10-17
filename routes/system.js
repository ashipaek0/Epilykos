/**
 * Appliance system actions for Settings → System (EpilykosOS only,
 * contract C-HOST-001): Restart, Shut down, Change Wi-Fi (Bluetooth setup),
 * the dashboard port, and the SSH maintenance login. Every route needs an
 * admin session; the global /api CSRF check applies too. Passwords are never
 * logged.
 *
 * @module routes/system
 */
'use strict';
const express = require('express');
const { logger } = require('../modules/logger');
const hostActions = require('../modules/hostActions');

const router = express.Router();

/** Forward one action; relay the host's reply or a clean error. */
function forward(action, pick = () => ({})) {
  return async (req, res) => {
    if (!hostActions.available()) {
      return res.status(404).json({ error: 'System actions are only available on EpilykosOS' });
    }
    try {
      const reply = await hostActions.call(action, pick(req.body || {}));
      if (!reply || reply.ok !== true) {
        return res.status(400).json({ error: (reply && reply.error) || 'The appliance refused the request' });
      }
      delete reply.ok;
      res.json(Object.assign({ success: true }, reply));
    } catch (err) {
      logger.warn(`System action ${action} failed: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  };
}

// Whether this instance is an EpilykosOS appliance, and its current state.
router.get('/', async (req, res) => {
  if (!hostActions.available()) return res.json({ appliance: false });
  try {
    const reply = await hostActions.call('status');
    if (!reply || reply.ok !== true) throw Object.assign(new Error(reply && reply.error || 'status failed'), { status: 502 });
    res.json({ appliance: true, os_version: reply.os_version || '', wifi_setup_until: reply.wifi_setup_until || 0, ssh: reply.ssh, port: reply.port || null });
  } catch (err) {
    res.status(err.status || 500).json({ appliance: true, error: err.message });
  }
});

router.post('/restart', (req, res, next) => { logger.info('Settings: restart requested'); next(); }, forward('restart'));
router.post('/shutdown', (req, res, next) => { logger.info('Settings: shutdown requested'); next(); }, forward('shutdown'));
router.post('/wifi-setup', forward('wifi_setup'));
// The host checks the port (80 or 1024-65535, free) and restarts the app on it.
router.post('/port', forward('set_port', b => ({ port: typeof b.port === 'number' || typeof b.port === 'string' ? b.port : null })));
router.post('/ssh/enable', forward('ssh_enable'));
router.post('/ssh/disable', forward('ssh_disable'));
router.post('/ssh/password', forward('ssh_set_password', b => ({ password: typeof b.password === 'string' ? b.password : '' })));
router.post('/ssh/password/clear', forward('ssh_clear_password'));
router.post('/ssh/keys', forward('ssh_add_key', b => ({ key: typeof b.key === 'string' ? b.key : '' })));
router.post('/ssh/keys/remove', forward('ssh_remove_key', b => ({ fingerprint: typeof b.fingerprint === 'string' ? b.fingerprint : '' })));

module.exports = router;
