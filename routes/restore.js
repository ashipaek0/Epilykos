/**
 * Restore and snapshot routes (mounted at /api): restoring from an uploaded database file, listing the automatic
 * snapshots and restoring from one. Signed-in only. A restore swaps the database under the running server, so the
 * lifecycle, the session store and the upload helpers come from server.js.
 *
 * @module routes/restore
 */
const express = require('express');
const fs = require('fs');
const { logger } = require('../modules/logger');
const { isAuthenticated } = require('../modules/sessionAuth');

/**
 * @param {object} deps restoreDatabase, restoreFromSnapshot, listSnapshots (modules/backup); restoreLifecycle and
 *   sessionStore (server.js); upload (the multer upload) and uploadedFilePath (checks an upload sits in its folder)
 * @returns {{ router: object, restoreSessionOptions: Function, restoreFailure: Function }} the two helpers are also
 *   used by the cloud-backup restore route
 */
module.exports = function createRestoreRoutes({ restoreDatabase, restoreFromSnapshot, listSnapshots, restoreLifecycle, sessionStore, upload, uploadedFilePath }) {
  const router = express.Router();

  // Capture authorization only at pre-close, so logout/expiry during a long
  // preparation is respected. Copy before confirmation without an open response.
  function restoreSessionOptions(req) {
    let captured;
    return {
      beforeActivate() { captured = sessionStore.captureForRestore(req.sessionID); },
      afterActivate() { sessionStore.restoreCaptured(captured); }
    };
  }
  function restoreFailure(res, err) {
    // A file that is not a database (or is damaged) is found while the upload is
    // checked, before anything is swapped: say so plainly instead of a 500.
    if (!err.restoreRecoveryRequired && !err.status && /^SQLITE_(NOTADB|CORRUPT)/.test(String(err.code || ''))) {
      err.status = 400;
      err.restorePreflight = true;
      err.message = 'That file is not an Epilykos backup, or it is damaged. Nothing was changed.';
    }
    // A refusal the person can act on (wrong file, passphrase needed) is not a server error.
    if (err.status && err.status < 500) logger.warn('Restore refused: ' + err.message);
    else logger.error('Restore error:', err);
    if (err.restoreRecoveryRequired) {
      // Files are retained for startup recovery. Do not serve a partly rebound
      // process indefinitely; the normal container/service supervisor restarts it.
      const timer = setTimeout(() => process.exit(1), 1000); timer.unref();
      res.once('finish', () => setImmediate(() => process.exit(1)));
    }
    return res.status(err.status || 500).json({ error: err.restorePreflight || err.restoreRecoveryRequired || err.code === 'DB_RETIRED' ? err.message : 'Restore failed, original database restored.' });
  }

  router.use('/restore', isAuthenticated);
  router.post('/restore', upload.single('dbfile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const uploaded = uploadedFilePath(req.file);
    if (!uploaded) return res.status(400).json({ error: 'Invalid upload' });
    try {
      await restoreDatabase(uploaded, { lifecycle: restoreLifecycle, ...restoreSessionOptions(req) });
      res.json({ success: true, message: 'Database restored successfully' });
    } catch (err) {
      restoreFailure(res, err);
    } finally {
      try { if (fs.existsSync(uploaded)) fs.unlinkSync(uploaded); } catch(e) {}
    }
  });

  // ── Snapshot API ──────────────────────────────────────────────

  router.use('/snapshots', isAuthenticated);
  router.get('/snapshots/status', (req, res) => res.json(require('../modules/backup').snapshotStatus()));
  router.get('/snapshots', (req, res) => {
    try {
      res.json(listSnapshots());
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/snapshots/restore/:name', async (req, res) => {
    try {
      const result = await restoreFromSnapshot(decodeURIComponent(req.params.name), { lifecycle: restoreLifecycle, ...restoreSessionOptions(req) });
      res.json(result);
    } catch (err) {
      restoreFailure(res, err);
    }
  });

  return { router, restoreSessionOptions, restoreFailure };
};
