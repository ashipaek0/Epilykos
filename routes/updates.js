'use strict';
/**
 * Settings → Updates: which build this is, whether a newer one is out, and
 * "Update now". Signed-in only (mounted behind isAuthenticated); installing
 * also needs the admin password again.
 *
 * How an update is installed depends on where Epilykos runs:
 *   epilykos-os  the appliance installs it (host actions update_check / update_apply)
 *   docker       Docker Compose with the Docker socket mounted (modules/dockerUpdate.js)
 *   compose      Docker Compose without the socket: the page shows the commands
 *   none         not in a container (development): nothing to install
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { setConfig } = require('../modules/database');
const { verifyPassword } = require('../modules/sessionAuth');
const updates = require('../modules/updates');
const dockerUpdate = require('../modules/dockerUpdate');
const hostActions = require('../modules/hostActions');

function method() {
  if (hostActions.available()) {
    const host = updates.lastHostStatus();
    return { kind: 'epilykos-os', supported: !host || host.supported !== false };
  }
  const a = dockerUpdate.availability();
  if (a === 'ready') return { kind: 'docker' };
  if (a === 'no-socket') return { kind: 'compose' };
  return { kind: 'none' };
}

function router() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const m = method();
    const result = m.kind === 'docker' ? await dockerUpdate.reconcile() : dockerUpdate.lastResult();
    res.json({
      installed: updates.installed(),
      status: updates.lastStatus(),
      host: m.kind === 'epilykos-os' ? updates.lastHostStatus() : null,
      auto: updates.autoCheck(),
      autoLocked: /^(off|false|0|no)$/i.test(String(process.env.UPDATE_CHECK || '')),
      method: m,
      applying: m.kind === 'docker' ? dockerUpdate.applying() : null,
      lastResult: result && result.finishedAt ? result : null,
    });
  });

  r.post('/check', async (req, res) => {
    const [status, host] = await Promise.all([updates.check(), updates.hostCheck()]);
    res.json({ status, host });
  });

  r.post('/auto', (req, res) => {
    const on = !!(req.body && req.body.on);
    setConfig('update_check_auto', on ? 'true' : 'false');
    logger.info(`[updates] Daily update check ${on ? 'on' : 'off'}`);
    res.json({ auto: updates.autoCheck() });
  });

  r.post('/result/dismiss', (req, res) => {
    setConfig('update_last_result', '');
    res.json({ ok: true });
  });

  r.post('/apply', async (req, res) => {
    const body = req.body || {};
    if (typeof body.password !== 'string' || !verifyPassword(body.password)) {
      return res.status(403).json({ error: 'Enter your admin password to install the update.' });
    }
    const m = method();
    try {
      if (m.kind === 'epilykos-os') {
        const target = body.target === 'os' ? 'os' : 'app';
        const reply = await hostActions.call('update_apply', { target }, { timeoutMs: 60000 });
        if (!reply || reply.ok !== true) return res.status(400).json({ error: (reply && reply.error) || 'The appliance refused the update' });
        logger.warn(`[updates] EpilykosOS is installing the ${target === 'os' ? 'system' : 'Epilykos'} update`);
        return res.json({ state: reply.state || 'applying', message: reply.message || '' });
      }
      if (m.kind === 'docker') {
        logger.warn('[updates] Update requested from Settings');
        return res.json(await dockerUpdate.apply());
      }
      return res.status(400).json({ error: m.kind === 'compose'
        ? 'This install cannot update itself. Run the commands shown on this page, or mount the Docker socket (see docker-compose.yaml).'
        : 'Not running in Docker: update this copy with git pull and restart it.' });
    } catch (err) {
      logger.warn(`[updates] Update failed: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = { router, method };
