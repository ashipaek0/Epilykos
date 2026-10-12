'use strict';
/**
 * modules/notifications — alerts on any metric or event, sent to Telegram,
 * Discord, ntfy and web push on the admin's devices.
 *
 *   events.js     project-wide event bus + catalog (emitEvent from any module)
 *   rules.js      metric / event rule evaluation (pure)
 *   dispatcher.js quiet hours, retries, delivery log
 *   store.js      config-backed persistence
 *   routes.js     /api/notifications (admin only)
 *
 * server.js calls init() once, evaluateMetrics() after every poll cycle's
 * flush, and noteSourceResult() from the PollingManager events.
 */

const { logger } = require('../logger');
const { getDb } = require('../database');
const store = require('./store');
const events = require('./events');
const rules = require('./rules');
const dispatcher = require('./dispatcher');

const evaluator = rules.createMetricEvaluator();
const eventCooldowns = new Map();
let initialised = false;

function rulesFor(kind) {
  return store.getRules().filter(r => r && r.kind === kind && r.enabled);
}

function severityOf(rule, fallback) {
  return events.SEVERITIES.includes(rule.severity) ? rule.severity : (fallback || 'warning');
}

/** Read every latest_metrics row into a Map (name → row). */
function latestRows() {
  const rows = getDb().prepare('SELECT metric, value, value_text, value_type, unit, timestamp FROM latest_metrics').all();
  return new Map(rows.map(r => [r.metric, r]));
}

/** Evaluate metric rules against latest_metrics. Called after each poll cycle flush. */
function evaluateMetrics(now = Math.floor(Date.now() / 1000)) {
  if (!initialised) return [];
  let hits = [];
  try {
    const metricRules = rulesFor('metric');
    if (!metricRules.length) { evaluator.evaluate([], new Map(), now); return []; }
    hits = evaluator.evaluate(metricRules, latestRows(), now);
  } catch (e) {
    logger.warn(`notifications: metric rule evaluation failed: ${e.message}`);
    return [];
  }
  for (const hit of hits) {
    const { title, body } = rules.metricMessage(hit, now);
    const severity = hit.transition === 'resolve' ? 'info' : severityOf(hit.rule);
    dispatcher.deliver({ title, body, severity, tag: 'rule-' + hit.rule.id }, hit.rule.channels, hit.rule)
      .catch(e => logger.warn(`notifications: delivery failed: ${e.message}`));
  }
  return hits;
}

function handleEvent(event) {
  let matched = [];
  try {
    matched = rules.matchEventRules(rulesFor('event'), event, event.timestamp, eventCooldowns);
  } catch (e) {
    logger.warn(`notifications: event rule matching failed: ${e.message}`);
    return;
  }
  for (const rule of matched) {
    const { title, body } = rules.eventMessage(rule, event);
    const severity = severityOf(rule, event.severity);
    dispatcher.deliver({ title, body, severity, tag: 'event-' + event.type + (event.subject ? '-' + event.subject : '') }, rule.channels, rule)
      .catch(e => logger.warn(`notifications: delivery failed: ${e.message}`));
  }
}

// ── Source health → source.offline / source.online ──────────────────

const OFFLINE_AFTER_FAILURES = 3;
const sourceHealth = new Map(); // sourceId → { failures, offline, since }

function noteSourceResult(sourceId, ok, error) {
  const h = sourceHealth.get(sourceId) || { failures: 0, offline: false, since: 0 };
  if (ok) {
    if (h.offline) {
      const down = Math.max(60, Math.floor(Date.now() / 1000) - h.since);
      events.emitEvent('source.online', { subject: sourceId, message: `${sourceId} is responding again after ${rules.fmtMinutes(down)}.` });
    }
    sourceHealth.set(sourceId, { failures: 0, offline: false, since: 0 });
    return;
  }
  h.failures++;
  if (!h.offline && h.failures >= OFFLINE_AFTER_FAILURES) {
    h.offline = true;
    h.since = Math.floor(Date.now() / 1000);
    const reason = error && error.message ? error.message : (error ? String(error) : 'no response');
    events.emitEvent('source.offline', { subject: sourceId, message: `${sourceId} failed ${h.failures} polls in a row: ${reason}` });
  }
  sourceHealth.set(sourceId, h);
}

function init() {
  if (initialised) return;
  store.ensureSchema();
  events.onEvent(handleEvent);
  initialised = true;
  events.emitEvent('system.started', { message: 'The Epilykos server started.' });
}

module.exports = {
  init,
  evaluateMetrics,
  noteSourceResult,
  handleEvent,
  emitEvent: events.emitEvent,
  _evaluator: evaluator,
};
