'use strict';
const express = require('express');
const backupSecrets = require('../modules/backupSecrets');

const PENDING_MS = 2 * 60 * 1000;

/**
 * GET  /api/backup                 the database as it is
 * POST /api/backup/protect         hold a passphrase for this session for two minutes
 * GET  /api/backup?protect=1       the database with its saved passwords locked by that passphrase, used once
 *
 * The passphrase travels in a POST body, never in a URL, so it stays out of
 * logs and browser history; the download itself is a plain navigation.
 */
module.exports = function backupRoutes(backupDatabase, { now = Date.now } = {}) {
  const router = express.Router();
  const pending = new Map();   // session id → { passphrase, expires }

  router.post('/protect', (req, res) => {
    try {
      const passphrase = backupSecrets.normalise(req.body?.passphrase);
      for (const [id, entry] of pending) if (entry.expires <= now()) pending.delete(id);
      pending.set(req.sessionID, { passphrase, expires: now() + PENDING_MS });
      res.json({ ok: true });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });

  router.get('/', (req, res) => {
    if (!req.query.protect) return backupDatabase(res);
    const entry = pending.get(req.sessionID);
    pending.delete(req.sessionID);
    if (!entry || entry.expires <= now()) return res.status(400).json({ error: 'The passphrase was not received or has expired. Enter it again.' });
    return backupDatabase(res, { passphrase: entry.passphrase });
  });

  return router;
};
