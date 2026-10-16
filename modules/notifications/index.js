'use strict';
/**
 * modules/notifications — alerts on any metric or event, sent to Telegram,
 * Discord, ntfy and web push on the admin's devices.
 *
 *   events.js     project-wide event bus + catalog (emitEvent from any module)
 *   rules.js      metric / event rule evaluation (pure)
 *   dispatcher.js quiet hours, retries, delivery log
 *   store.js      config-backed persistence
 *   reports.js    day summary, forecast and status texts
 *   telegramBot.js answers /status, /today, /forecast in the configured chat
 *   routes.js     /api/notifications (admin only)
 *
 * server.js calls init() once, evaluateMetrics() after every poll cycle's
 * flush, and noteSourceResult() from the PollingManager events. Scheduled
 * rules run off their own minute timer. Rule state (firing, cooldowns, last
 * scheduled run) is saved whenever it changes, so a restart neither repeats
 * an alert nor forgets a cooldown.
 */

const { logger } = require('../logger');
const { getDb } = require('../database');
const store = require('./store');
const events = require('./events');
const rules = require('./rules');
const dispatcher = require('./dispatcher');
const reports = require('./reports');
const { localDateString } = require('../localTime');

const evaluator = rules.createMetricEvaluator();
const eventCooldowns = new Map();
const scheduleRuns = {}; // rule.id → local day it last ran
let initialised = false;
let scheduleTimer = null;
let savedStateJson = '';

function loadState() {
  const st = store.getState();
  evaluator.importState(st.metric);
  for (const [k, v] of Object.entries(st.events || {})) if (Number.isFinite(v)) eventCooldowns.set(k, v);
  Object.assign(scheduleRuns, st.schedule || {});
  savedStateJson = JSON.stringify(currentState());
}

function currentState() {
  // Event cooldowns older than a week can never matter again.
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const events = {};
  for (const [k, v] of eventCooldowns) if (v > cutoff) events[k] = v;
  return { metric: evaluator.exportState(), events, schedule: { ...scheduleRuns } };
}

/** Persist rule state when it changed (cheap string compare every cycle). */
function saveStateIfChanged() {
  try {
    const json = JSON.stringify(currentState());
    if (json === savedStateJson) return;
    store.saveState(JSON.parse(json));
    savedStateJson = json;
  } catch (e) {
    logger.warn(`notifications: could not save rule state: ${e.message}`);
  }
}

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
  } finally {
    saveStateIfChanged();
  }
  for (const hit of hits) {
    const { title, body } = rules.metricMessage(hit, now);
    const severity = hit.transition === 'resolve' ? 'info' : severityOf(hit.rule);
    dispatcher.deliver({ title, body, severity, tag: 'rule-' + hit.rule.id, rule: hit.rule.name, metric: hit.rule.metric }, hit.rule.channels, hit.rule)
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
  if (matched.length) saveStateIfChanged();
  for (const rule of matched) {
    const { title, body } = rules.eventMessage(rule, event);
    const severity = severityOf(rule, event.severity);
    dispatcher.deliver({ title, body, severity, tag: 'event-' + event.type + (event.subject ? '-' + event.subject : ''), rule: rule.name, event: event.type }, rule.channels, rule)
      .catch(e => logger.warn(`notifications: delivery failed: ${e.message}`));
  }
}

// ── Source health → source.offline / source.online ──────────────────

const OFFLINE_AFTER_FAILURES = 3;
// PollingManager source ids → names people recognise (the id stays the event subject).
const SOURCE_LABELS = { ha: 'Home Assistant', modbus: 'Modbus', tuya: 'Tuya', rs232: 'RS232', history: 'History logger', grid: 'Grid status' };
const sourceLabel = (id) => SOURCE_LABELS[id] || id;
const sourceHealth = new Map(); // sourceId → { failures, offline, since }

function noteSourceResult(sourceId, ok, error) {
  const h = sourceHealth.get(sourceId) || { failures: 0, offline: false, since: 0 };
  if (ok) {
    if (h.offline) {
      const down = Math.max(60, Math.floor(Date.now() / 1000) - h.since);
      events.emitEvent('source.online', { subject: sourceId, message: `${sourceLabel(sourceId)} is responding again after ${rules.fmtMinutes(down)}.` });
    }
    sourceHealth.set(sourceId, { failures: 0, offline: false, since: 0 });
    return;
  }
  h.failures++;
  if (!h.offline && h.failures >= OFFLINE_AFTER_FAILURES) {
    h.offline = true;
    h.since = Math.floor(Date.now() / 1000);
    const reason = error && error.message ? error.message : (error ? String(error) : 'no response');
    events.emitEvent('source.offline', { subject: sourceId, message: `${sourceLabel(sourceId)} failed ${h.failures} polls in a row: ${reason}` });
  }
  sourceHealth.set(sourceId, h);
}

// ── Scheduled reports ────────────────────────────────────────────────

/**
 * Build a schedule rule's report. Resolves { title, body, skip } — skip is
 * set when a forecast rule's "only below N kWh" condition is not met.
 */
async function buildReport(rule) {
  const def = reports.REPORTS[rule.report];
  if (!def) throw new Error(`Unknown report ${rule.report}`);
  const r = await def.build(rule.day);
  let skip = null;
  if (rule.report === 'forecast' && Number(rule.below_kwh) > 0) {
    if (r.data.kwh === null) skip = 'no forecast available';
    else if (r.data.kwh >= Number(rule.below_kwh)) skip = `forecast ${r.data.kwh} kWh is not below ${rule.below_kwh} kWh`;
  }
  // The rule's own name is the title; the report's title ("Tomorrow's solar
  // forecast") leads the body so the day is never ambiguous.
  const body = [rule.message, rule.name ? r.title : null, r.body].filter(Boolean).join('\n');
  return { title: rule.name || r.title, body, skip };
}

/** Run every schedule rule due at `date` (local time). Returns the rules run. */
async function runSchedules(date = new Date()) {
  if (!initialised) return [];
  const today = localDateString(date);
  const due = rules.dueSchedules(rulesFor('schedule'), date, scheduleRuns, today);
  if (!due.length) return [];
  for (const rule of due) scheduleRuns[rule.id] = today; // mark first: never twice, even if slow
  saveStateIfChanged();
  for (const rule of due) {
    try {
      const rep = await buildReport(rule);
      if (rep.skip) { logger.debug(`notifications: "${rule.name}" skipped (${rep.skip})`); continue; }
      await dispatcher.deliver({ title: rep.title, body: rep.body, severity: severityOf(rule, 'info'), tag: 'report-' + rule.id, rule: rule.name }, rule.channels, rule, { ignoreQuiet: true });
    } catch (e) {
      logger.warn(`notifications: scheduled report "${rule.name}" failed: ${e.message}`);
    }
  }
  return due;
}

function init() {
  if (initialised) return;
  store.ensureSchema();
  loadState();
  events.onEvent(handleEvent);
  initialised = true;
  scheduleTimer = setInterval(() => { runSchedules().catch(() => {}); }, 30000);
  if (scheduleTimer.unref) scheduleTimer.unref();
  require('./telegramBot').sync();
  events.emitEvent('system.started', { message: 'The Epilykos server started.' });
}

function stop() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
  require('./telegramBot').stopAll();
}

module.exports = {
  init,
  stop,
  evaluateMetrics,
  runSchedules,
  buildReport,
  noteSourceResult,
  handleEvent,
  emitEvent: events.emitEvent,
  _evaluator: evaluator,
};
