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
  const overview = () => ({ settings: service.settings(), status: service.status() });

  router.get('/', handle((req, res) => res.json(overview())));
  router.post('/settings', handle((req, res) => { service.saveSettings(req.body || {}); res.json(overview()); }));
  router.post('/test', handle(async (req, res) => res.json(await service.test(req.body || {}))));
  router.post('/run', handle(async (req, res) => {
    const result = await service.run({ manual: true });
    res.status(result.ok ? 200 : 502).json({ ...result, ...overview() });
  }));
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
