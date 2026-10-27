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
const osUpdates = require('../modules/osUpdates');

/** The admin password again, checked here and never sent to the host. */
function passwordOk(body) {
  return !!body && typeof body.password === 'string' && verifyPassword(body.password);
}

/** EpilykosOS update actions reply { os } or { error } with the host's reason. */
function osRoute(fn, { password } = {}) {
  return async (req, res) => {
    const body = req.body || {};
    if (password && !passwordOk(body)) return res.status(403).json({ error: `Enter your admin password to ${password}.` });
    try {
      res.json({ os: await fn(body) });
    } catch (err) {
      if (!err.status || err.status >= 500) logger.warn(`[updates] EpilykosOS update: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  };
}

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
    const job = reply.app.job || {};
    // step: the host's own job state (downloading, then starting: the new
    // version is started and must report healthy before it is kept).
    return { applying: reply.app.state === 'applying' ? { startedAt: job.started_at || null, step: job.state || null } : null, lastResult };
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
      os: m.kind === 'epilykos-os' ? await osUpdates.status() : null,
      auto: updates.autoCheck(),
      autoInstall: updates.autoInstall(),
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

  r.post('/auto-install', (req, res) => {
    const body = req.body || {};
    if (body.on !== false && body.on !== true) return res.status(400).json({error:'Choose on or off'});
    if (body.on && (!hostActions.available() || !updates.autoCheck())) return res.status(400).json({error:'Automatic installation needs EpilykosOS and daily checks enabled.'});
    if (body.on && (typeof body.password !== 'string' || !verifyPassword(body.password))) return res.status(403).json({error:'Enter your admin password to enable automatic installation.'});
    setConfig('update_install_auto', body.on ? 'true' : 'false');
    res.json({autoInstall: updates.autoInstall()});
  });

  r.post('/result/dismiss', async (req, res) => {
    setConfig('update_last_result', '');
    if (method().kind === 'epilykos-os') {
      const host = await hostProgress();
      if (host && host.lastResult) setConfig('update_host_result_dismissed', host.lastResult.finishedAt);
    }
    res.json({ ok: true });
  });

  // EpilykosOS system updates (design §10.2). The appliance does the work;
  // a job keeps going whether or not this page stays open.
  r.post('/os/check', osRoute(() => osUpdates.check()));
  r.post('/os/install', osRoute(b => {
    logger.warn(`[updates] EpilykosOS update ${b.sequence} requested from Settings`);
    return osUpdates.install({ sequence: b.sequence, sha256: b.sha256, requestId: b.request_id });
  }, { password: 'install the system update' }));
  r.post('/os/cancel', osRoute(b => osUpdates.cancel(b.job)));
  r.post('/os/restart', osRoute(b => {
    logger.warn('[updates] Restart to finish the EpilykosOS update requested from Settings');
    return osUpdates.restart(b.job);
  }, { password: 'restart onto the new system' }));
  r.post('/os/discard', osRoute(b => osUpdates.discard(b.job), { password: 'discard the system update' }));
  r.post('/os/dismiss', osRoute(b => osUpdates.dismiss(b.job)));

  r.post('/apply', async (req, res) => {
    const body = req.body || {};
    if (!passwordOk(body)) {
      return res.status(403).json({ error: 'Enter your admin password to install the update.' });
    }
    const m = method();
    try {
      if (m.kind === 'epilykos-os') {
        // System updates go only through the EpilykosOS card (/os/*).
        if (body.target === 'os') return res.status(400).json({ error: 'Install system updates from the EpilykosOS card.' });
        const reply = await hostActions.call('update_apply', { target: 'app' }, { timeoutMs: 60000 });
        if (!reply || reply.ok !== true) return res.status(400).json({ error: (reply && reply.error) || 'The appliance refused the update' });
        logger.warn('[updates] EpilykosOS is installing the Epilykos update');
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
