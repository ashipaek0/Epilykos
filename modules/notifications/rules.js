'use strict';
/**
 * modules/notifications/rules.js — rule evaluation (pure: no DB, no I/O).
 *
 * Two kinds of rule:
 *   metric — compares any metric in latest_metrics each poll cycle.
 *            Operators: gt gte lt lte (numeric, with hysteresis), eq neq
 *            (numbers or text, e.g. a 'Grid Status' of 'off'), changes
 *            (any new value), stale (no update for `value` minutes).
 *   event  — matches events from the bus (events.js) by type or wildcard.
 *   schedule — sends a report (reports.js) at a local time each day; a
 *            forecast report can be limited to days below a kWh threshold.
 *
 * Metric rule lifecycle: idle → pending (condition true, waiting `for_s`)
 * → firing (notified) → idle on resolve. A re-fire inside `cooldown_s` of
 * the last notification is silent (and so is its resolve); `repeat_s`
 * re-notifies while a rule stays firing. Missing or non-numeric data never
 * resolves a firing rule — a source dropping out is not "back to normal".
 */

const { eventMatches } = require('./events');

const OPERATORS = {
  gt: { label: 'is above', symbol: '>' },
  gte: { label: 'is at or above', symbol: '≥' },
  lt: { label: 'is below', symbol: '<' },
  lte: { label: 'is at or below', symbol: '≤' },
  eq: { label: 'equals', symbol: '=' },
  neq: { label: 'does not equal', symbol: '≠' },
  changes: { label: 'changes', symbol: '' },
  stale: { label: 'has not updated for (minutes)', symbol: '' },
};

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Value of a latest_metrics row: number when numeric, else trimmed text (compared case-insensitively). */
function readingOf(row) {
  if (!row) return null;
  const n = toNumber(row.value);
  if (n !== null) return n;
  if (row.value_text != null) {
    const tn = toNumber(row.value_text);
    return tn !== null ? tn : String(row.value_text).trim();
  }
  return null;
}

function sameValue(a, b) {
  const na = toNumber(a), nb = toNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Is the condition met? true / false, or null when the data cannot decide
 * (missing metric, text where a number is needed).
 * `phase` 'firing' applies hysteresis to the numeric operators.
 */
function conditionMet(rule, reading, row, now, phase) {
  const op = rule.operator;
  if (op === 'stale') {
    if (!row || !row.timestamp) return null;
    const minutes = toNumber(rule.value) || 0;
    return now - row.timestamp > minutes * 60;
  }
  if (reading === null) return null;
  if (op === 'eq') return sameValue(reading, rule.value);
  if (op === 'neq') return !sameValue(reading, rule.value);
  const v = toNumber(reading), t = toNumber(rule.value);
  if (v === null || t === null) return null;
  const h = phase === 'firing' ? Math.abs(toNumber(rule.hysteresis) || 0) : 0;
  switch (op) {
    case 'gt': return v > t - h;
    case 'gte': return v >= t - h;
    case 'lt': return v < t + h;
    case 'lte': return v <= t + h;
    default: return null;
  }
}

function signature(rule) {
  return JSON.stringify([rule.metric, rule.operator, rule.value, rule.hysteresis, rule.for_s]);
}

/**
 * Stateful evaluator for metric rules. evaluate() returns the transitions
 * to notify: [{ rule, transition: 'fire'|'resolve'|'repeat'|'change', reading, previous, row }].
 */
function createMetricEvaluator() {
  const states = new Map(); // rule.id → state

  function evaluate(rules, metricRows, now) {
    const out = [];
    const seen = new Set();
    for (const rule of rules) {
      if (!rule || rule.kind !== 'metric' || !rule.enabled || !rule.metric || !OPERATORS[rule.operator]) continue;
      seen.add(rule.id);
      let st = states.get(rule.id);
      const sig = signature(rule);
      if (!st || st.sig !== sig) {
        st = { sig, phase: 'idle', since: 0, lastNotified: 0, notified: false, lastValue: undefined, lastTs: 0 };
        states.set(rule.id, st);
      }
      const row = metricRows.get(rule.metric);
      const reading = readingOf(row);
      const cooldown = Math.max(0, toNumber(rule.cooldown_s) || 0);
      const inCooldown = st.lastNotified && now - st.lastNotified < cooldown;

      if (rule.operator === 'changes') {
        // Only a new sample counts (MQTT can resend the same value).
        if (reading === null || !row) continue;
        if (st.lastValue === undefined) { st.lastValue = reading; st.lastTs = row.timestamp; continue; }
        if (!sameValue(reading, st.lastValue)) {
          const previous = st.lastValue;
          st.lastValue = reading; st.lastTs = row.timestamp;
          if (!inCooldown) { st.lastNotified = now; out.push({ rule, transition: 'change', reading, previous, row }); }
        }
        continue;
      }

      const met = conditionMet(rule, reading, row, now, st.phase);
      if (met === null) {
        if (st.phase === 'pending') st.phase = 'idle'; // data gone: restart the wait
        continue;
      }
      if (st.phase === 'idle') {
        if (met) { st.phase = 'pending'; st.since = now; }
      } else if (st.phase === 'pending' && !met) {
        st.phase = 'idle';
      }
      if (st.phase === 'pending' && met && now - st.since >= (toNumber(rule.for_s) || 0)) {
        st.phase = 'firing';
        st.notified = !inCooldown;
        if (st.notified) { st.lastNotified = now; out.push({ rule, transition: 'fire', reading, row }); }
        continue;
      }
      if (st.phase === 'firing') {
        if (!met) {
          st.phase = 'idle';
          if (st.notified && rule.notify_resolved) out.push({ rule, transition: 'resolve', reading, row });
          st.notified = false;
        } else {
          const repeat = toNumber(rule.repeat_s) || 0;
          if (repeat > 0 && now - st.lastNotified >= repeat) {
            st.lastNotified = now; st.notified = true;
            out.push({ rule, transition: 'repeat', reading, row });
          }
        }
      }
    }
    for (const id of states.keys()) if (!seen.has(id)) states.delete(id);
    return out;
  }

  /** Plain object of every rule's state, for persisting across restarts. */
  function exportState() {
    const o = {};
    for (const [id, st] of states) o[id] = { ...st };
    return o;
  }
  /** Restore exportState() output; rules whose definition changed since start over (sig check). */
  function importState(o) {
    if (!o || typeof o !== 'object') return;
    for (const [id, st] of Object.entries(o)) {
      if (st && typeof st === 'object' && typeof st.sig === 'string' && ['idle', 'pending', 'firing'].includes(st.phase)) states.set(id, { ...st });
    }
  }

  return { evaluate, states, exportState, importState };
}

// ── Scheduled rules ──────────────────────────────────────────────────

/** "HH:MM" → minutes after midnight, or null. */
function clockMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

const SCHEDULE_GRACE_MIN = 120; // a schedule missed by a restart still runs if we are back within 2 h

/**
 * Schedule rules due at local time `date`. `lastRun` maps rule.id → the
 * local day ('YYYY-MM-DD') it last ran; the caller records runs.
 * days: optional [0-6] (Sunday = 0) to limit the weekdays.
 */
function dueSchedules(rules, date, lastRun, today) {
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const out = [];
  for (const rule of rules) {
    if (!rule || rule.kind !== 'schedule' || !rule.enabled) continue;
    const at = clockMinutes(rule.time);
    if (at === null || nowMin < at || nowMin - at > SCHEDULE_GRACE_MIN) continue;
    if (Array.isArray(rule.days) && rule.days.length && !rule.days.includes(date.getDay())) continue;
    if (lastRun[rule.id] === today) continue;
    out.push(rule);
  }
  return out;
}

/**
 * Event rules matching `event`, honouring per rule + subject cooldowns.
 * `lastSent` is a Map the caller keeps across calls.
 */
function matchEventRules(rules, event, now, lastSent) {
  const out = [];
  for (const rule of rules) {
    if (!rule || rule.kind !== 'event' || !rule.enabled) continue;
    if (!eventMatches(rule.event, event.type)) continue;
    if (rule.subject && String(rule.subject).trim().toLowerCase() !== String(event.subject || '').trim().toLowerCase()) continue;
    const key = rule.id + '|' + (event.subject || '');
    const cooldown = Math.max(0, toNumber(rule.cooldown_s) || 0);
    const last = lastSent.get(key) || 0;
    if (last && now - last < cooldown) continue;
    lastSent.set(key, now);
    out.push(rule);
  }
  return out;
}

// ── Message text ─────────────────────────────────────────────────────

function fmtValue(v, unit) {
  if (v === null || v === undefined) return 'no value';
  const n = toNumber(v);
  const s = n !== null ? String(Math.round(n * 100) / 100) : String(v);
  return unit ? `${s} ${unit}` : s;
}

function fmtMinutes(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function applyTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (all, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : all));
}

/** { title, body } for a metric rule transition. */
function metricMessage(hit, now) {
  const { rule, transition, reading, previous, row } = hit;
  const unit = (row && row.unit) || rule.unit || '';
  const vars = {
    rule: rule.name, metric: rule.metric, value: fmtValue(reading, unit), unit,
    threshold: fmtValue(rule.value, rule.operator === 'stale' ? '' : unit), previous: fmtValue(previous, unit),
  };
  let body;
  if (transition === 'resolve') {
    body = rule.operator === 'stale' ? `${rule.metric} is updating again.` : `${rule.metric} is back to ${vars.value}.`;
  } else if (transition === 'change') {
    body = `${rule.metric} changed from ${vars.previous} to ${vars.value}.`;
  } else if (rule.operator === 'stale') {
    const age = row && row.timestamp ? now - row.timestamp : 0;
    body = `${rule.metric} has not updated for ${fmtMinutes(age)}.`;
  } else {
    body = `${rule.metric} ${OPERATORS[rule.operator].label} ${vars.threshold}: now ${vars.value}.`;
    if ((toNumber(rule.for_s) || 0) >= 60) body = body.slice(0, -1) + ` for ${fmtMinutes(rule.for_s)}.`;
  }
  if (rule.message && transition !== 'resolve') body = applyTemplate(rule.message, vars);
  const title = transition === 'resolve' ? `Resolved: ${rule.name}` : (transition === 'repeat' ? `Still active: ${rule.name}` : rule.name);
  return { title, body };
}

/** { title, body } for an event rule. */
function eventMessage(rule, event) {
  const vars = { rule: rule.name, event: event.type, subject: event.subject, message: event.message, title: event.title };
  return {
    title: rule.name || event.title,
    body: rule.message ? applyTemplate(rule.message, vars) : (event.message || event.title),
  };
}

module.exports = {
  OPERATORS,
  createMetricEvaluator,
  dueSchedules,
  clockMinutes,
  matchEventRules,
  metricMessage,
  eventMessage,
  readingOf,
  conditionMet,
  fmtMinutes,
};
