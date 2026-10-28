'use strict';
const express = require('express');
module.exports = function restoreUploadRoutes(manager) {
  const router = express.Router();
  const handle = operation => async (req, res) => {
    try { await operation(req, res); }
    catch (error) { if (!res.headersSent && !res.destroyed) res.status(error.status || (error.code === 'ENOSPC' ? 507 : 500)).json({ error: error.message }); }
  };
  router.get('/', handle((req, res) => res.json({ ...manager.capacity(), status: manager.status() })));
  router.post('/', handle(async (req, res) => res.status(201).json(await manager.create({ bytes: req.body?.bytes, name: req.body?.name, sessionId: req.sessionID }))));
  router.get('/:id', handle((req, res) => res.json(manager.status(req.params.id))));
  router.put('/:id/chunks', handle(async (req, res) => {
    if (req.headers['content-type'] !== 'application/octet-stream') return res.status(415).json({ error: 'Restore chunks require application/octet-stream' });
    const offset = req.headers['x-restore-offset'];
    if (typeof offset !== 'string' || !/^[0-9]+$/.test(offset)) return res.status(400).json({ error: 'A restore byte offset is required' });
    const length = req.headers['content-length'];
    const result = await manager.receive(req.params.id, Number(offset), req, length === undefined ? undefined : Number(length));
    res.status(result.phase === 'uploading' ? 200 : 202).json(result);
  }));
  router.post('/:id/passphrase', handle(async (req, res) => res.json(await manager.passphrase(req.params.id, { passphrase: req.body?.passphrase, skip: req.body?.skip }))));
  router.post('/:id/cancel', handle(async (req, res) => res.json(await manager.cancel(req.params.id))));
  return router;
};
