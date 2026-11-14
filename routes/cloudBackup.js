'use strict';
const express = require('express');

/**
 * /api/cloud-backup (signed in)
 *
 *   GET    /                         settings (never the passphrase) and status
 *   POST   /settings                 save settings; the passphrase travels in the body only
 *   POST   /test                     can we write to the destination?
 *   POST   /run                      back up now (returns when it has finished)
 *   GET    /copies                   the copies held at the destination
 *   POST   /copies/:name/check       does the passphrase open this copy?
 *   POST   /copies/:name/restore     download, unlock and restore this copy
 *   POST   /google/start             begin connecting Google Drive: a short code and an address
 *   GET    /google/poll              has the person finished? 'pending' | 'connected' | 'denied' | 'expired'
 *   POST   /google/cancel            forget a connection that is in progress
 *   POST   /google/disconnect        tell Google, forget the sign-in, and switch off a Google Drive backup
 */
module.exports = function cloudBackupRoutes(service, { restoreOptions = () => ({}), restoreFailure } = {}) {
  const router = express.Router();
  const handle = operation => async (req, res) => {
    try { await operation(req, res); }
    catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error.cloudBackup) return res.status(error.status || 422).json({ error: error.message });
      res.status(error.code === 'ENOSPC' ? 507 : 500).json({ error: error.message || 'Internal server error' });
    }
  };
  const overview = () => ({ settings: service.settings(), status: service.status(), google: service.googleStatus() });

  router.get('/', handle((req, res) => res.json(overview())));
  router.post('/settings', handle((req, res) => { service.saveSettings(req.body || {}); res.json(overview()); }));
  router.post('/test', handle(async (req, res) => res.json(await service.test(req.body || {}))));
  router.post('/run', handle(async (req, res) => {
    const result = await service.run({ manual: true });
    res.status(result.ok ? 200 : 502).json({ ...result, ...overview() });
  }));
  router.post('/google/start', handle(async (req, res) => res.json(await service.googleStart())));
  router.get('/google/poll', handle(async (req, res) => { const r = await service.googlePoll(); res.json(r.status === 'connected' ? { ...r, overview: overview() } : r); }));
  router.post('/google/cancel', handle((req, res) => res.json(service.googleCancel())));
  router.post('/google/disconnect', handle(async (req, res) => { await service.googleDisconnect(); res.json(overview()); }));
  router.get('/copies', handle(async (req, res) => res.json({ copies: await service.listCopies() })));
  router.post('/copies/:name/check', handle(async (req, res) => res.json(await service.checkCopy(req.params.name, { passphrase: req.body?.passphrase }))));
  router.post('/copies/:name/restore', async (req, res) => {
    try {
      await service.restoreCopy(req.params.name, { passphrase: req.body?.passphrase, restoreOptions: restoreOptions(req) });
      res.json({ success: true, message: 'Database restored successfully' });
    } catch (error) {
      if (error.cloudBackup) return res.status(error.status || 422).json({ error: error.message });
      if (restoreFailure) return restoreFailure(res, error);
      res.status(500).json({ error: 'Restore failed' });
    }
  });
  return router;
};
