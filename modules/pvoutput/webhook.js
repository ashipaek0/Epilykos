/**
 * PVOutput Webhook Receiver — Express router for PVOutput notification callbacks.
 *
 * Validates incoming alerts: rate-limited (10 req/min), SID-verified (S5).
 * Stores valid alerts in pvoutput_alerts table.
 *
 * @module pvoutput/webhook
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('../logger');

function createRouter(db, getConfigFn) {
  const router = express.Router();

  // S5: aggressive rate limiting on the public webhook endpoint
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    message: { error: 'Too many requests' }
  });

  router.post('/', webhookLimiter, express.urlencoded({ extended: false }), (req, res) => {
    const { sid, type, message, datetime } = req.body;

    if (!sid || !type) {
      return res.status(400).send('Bad Request');
    }

    // S5: validate system ID
    const raw = getConfigFn('pvoutput_config');
    let config = {};
    try { config = JSON.parse(raw || '{}'); } catch (e) { /* empty */ }
    if (String(sid) !== String(config.system_id)) {
      logger.warn(`[pvoutput:webhook] rejected alert for unknown system ${sid}`);
      return res.status(403).send('Forbidden');
    }

    try {
      db.prepare(
        `INSERT INTO pvoutput_alerts (system_id, alert_type, message, pvoutput_datetime, received_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(sid, parseInt(type), message || '', datetime || '');
      logger.info(`[pvoutput:webhook] alert type=${type}: ${message}`);
    } catch (e) {
      logger.error(`[pvoutput:webhook] failed to store alert: ${e.message}`);
    }

    res.status(200).send('OK');
  });

  return router;
}

module.exports = { createRouter };
