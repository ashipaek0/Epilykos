/**
 * PVOutput Webhook Receiver — Express router for PVOutput notification callbacks.
 *
 * This endpoint is unauthenticated by necessity (PVOutput's servers call it),
 * so it is gated defensively:
 *   - PVOutput must be configured AND enabled (otherwise the endpoint is shut);
 *   - the request `sid` must equal the configured system_id (timing-safe);
 *   - the request must carry the webhook token (a trailing /path segment or
 *     ?token=…), which Settings creates and shows. The system_id is semi-public,
 *     so without a token anyone who knew it could raise alerts here (they reach
 *     Telegram, ntfy and the like). With no token configured the endpoint is shut;
 *   - rate-limited (10 req/min), the stored message is length-capped and only the
 *     newest MAX_ALERTS alerts are kept.
 *
 * @module pvoutput/webhook
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { logger } = require('../logger');

const MAX_ALERTS = 500;

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

function createRouter(db, getConfigFn) {
  const router = express.Router();

  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    message: { error: 'Too many requests' }
  });

  function handle(req, res) {
    const { sid, type, message, datetime } = req.body;
    if (!sid || !type) return res.status(400).send('Bad Request');

    let config = {};
    try { config = JSON.parse(getConfigFn('pvoutput_config') || '{}'); } catch (e) { /* empty */ }

    // Endpoint is closed unless PVOutput is configured and explicitly enabled.
    const enabled = config.enabled === true || config.enabled === 'true';
    if (!config.system_id || !enabled) {
      return res.status(403).send('Forbidden');
    }
    // System id must match (timing-safe).
    if (!timingSafeEqual(String(sid), String(config.system_id))) {
      logger.warn(`[pvoutput:webhook] rejected alert for unknown system ${sid}`);
      return res.status(403).send('Forbidden');
    }
    // The shared secret is required: no token configured, or the wrong one, is refused.
    if (typeof config.webhook_token !== 'string' || config.webhook_token.length < 16) {
      logger.warn('[pvoutput:webhook] refused an alert: no webhook token yet (open Settings → PVOutput to create one)');
      return res.status(403).send('Forbidden');
    }
    const given = req.params.token || req.query.token || '';
    if (!timingSafeEqual(given, config.webhook_token)) {
      logger.warn('[pvoutput:webhook] rejected alert with bad/absent token');
      return res.status(403).send('Forbidden');
    }

    const alertType = parseInt(type);
    if (!Number.isInteger(alertType)) return res.status(400).send('Bad Request');
    const safeMessage = String(message || '').slice(0, 500);
    try {
      db.prepare(
        `INSERT INTO pvoutput_alerts (system_id, alert_type, message, pvoutput_datetime, received_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(String(sid), alertType, safeMessage, String(datetime || '').slice(0, 64));
      db.prepare('DELETE FROM pvoutput_alerts WHERE id NOT IN (SELECT id FROM pvoutput_alerts ORDER BY id DESC LIMIT ?)').run(MAX_ALERTS);
      logger.info(`[pvoutput:webhook] alert type=${alertType}`);
      require('../notifications/events').emitEvent('pvoutput.alert', { subject: String(alertType), message: safeMessage || `PVOutput alert type ${alertType}`, data: { type: alertType, datetime } });
    } catch (e) {
      logger.error(`[pvoutput:webhook] failed to store alert: ${e.message}`);
    }
    res.status(200).send('OK');
  }

  const parser = express.urlencoded({ extended: false });
  router.post('/', webhookLimiter, parser, handle);
  // Allow the shared secret as a trailing path segment too (some callers can
  // only append to the URL path, not add a query string).
  router.post('/:token', webhookLimiter, parser, handle);

  return router;
}

module.exports = { createRouter, MAX_ALERTS };
