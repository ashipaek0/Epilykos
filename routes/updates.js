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
const { getConfig, setConfig } = require('../modules/database');
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

/**
 * EpilykosOS: is the appliance installing an update, and how did the last one
 * end (host action update_status). Cheap, no network. Null when the host is
 * unreachable or older than these actions.
 */
async function hostProgress() {
  try {
    const reply = await hostActions.call('update_status', {}, { timeoutMs: 5000 });
    if (!reply || reply.ok !== true || !reply.app) return null;
    const last = reply.app.last_result;
    const lastResult = last && last.finished_at && last.finished_at !== getConfig('update_host_result_dismissed')
      ? { ok: !!last.ok, error: last.error || '', rolledBack: !!last.rolled_back, toVersion: last.release || '', finishedAt: last.finished_at }
      : null;
    return { applying: reply.app.state === 'applying' ? { startedAt: (reply.app.job && reply.app.job.started_at) || null } : null, lastResult };
  } catch (_) {
    return null;
  }
}

function router() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const m = method();
    const host = m.kind === 'epilykos-os' ? await hostProgress() : null;
    const result = m.kind === 'docker' ? await dockerUpdate.reconcile() : host ? host.lastResult : dockerUpdate.lastResult();
    res.json({
      installed: updates.installed(),
      status: updates.lastStatus(),
      host: m.kind === 'epilykos-os' ? updates.lastHostStatus() : null,
      auto: updates.autoCheck(),
      autoLocked: /^(off|false|0|no)$/i.test(String(process.env.UPDATE_CHECK || '')),
      method: m,
      applying: m.kind === 'docker' ? dockerUpdate.applying() : host ? host.applying : null,
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

  r.post('/result/dismiss', async (req, res) => {
    setConfig('update_last_result', '');
    if (method().kind === 'epilykos-os') {
      const host = await hostProgress();
      if (host && host.lastResult) setConfig('update_host_result_dismissed', host.lastResult.finishedAt);
    }
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

module.exports = { router, method, hostProgress };
