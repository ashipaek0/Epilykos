'use strict';
/**
 * modules/automations/evaluate.js — are an automation's conditions met right now? (pure)
 *
 * Unlike a notification rule, data that is too old counts as "unknown", not
 * as its last value: a frozen reading must not keep an automation firing.
 * An unknown condition decides nothing; the automation then does nothing.
 */
const { conditionMet } = require('../notifications/rules');

const CLOCK_FLOOR_S = Date.UTC(2024, 0, 1) / 1000;   // before this the clock has not been set (a Pi without a real-time clock)

/** Row in the shape rules.js reads. `metrics` is getCurrentMetrics() output: { name: { value, timestamp (ms) } }. */
function rowOf(metrics, name) {
  const m = metrics && metrics[name];
  if (!m || m.value === undefined || m.value === null) return null;
  return { value: m.value, value_text: typeof m.value === 'string' ? m.value : null, timestamp: Math.floor((Number(m.timestamp) || 0) / 1000) };
}

function metricPart(c, def, metrics, nowS, wasActive) {
  const row = rowOf(metrics, c.metric);
  if (!row) return { type: 'metric', met: null, reason: `No reading for ${c.metric}` };
  const age = nowS - row.timestamp;
  const limit = c.max_age_s || def.max_age_s;
  if (age > limit) return { type: 'metric', met: null, reason: `${c.metric} has not updated for ${Math.round(age / 60)} min`, value: row.value, age };
  const reading = typeof row.value === 'string' && !Number.isFinite(Number(row.value)) ? row.value.trim() : Number(row.value);
  const met = conditionMet({ operator: c.operator, value: c.value, hysteresis: c.hysteresis }, reading, row, nowS, wasActive ? 'firing' : 'idle');
  return { type: 'metric', met, value: row.value, age, reason: met === null ? `${c.metric} is not a usable number` : '' };
}

function timePart(c, nowMs) {
  if (nowMs / 1000 < CLOCK_FLOOR_S) return { type: 'time', met: null, reason: 'The clock has not been set yet' };
  const d = new Date(nowMs);
  const mins = d.getHours() * 60 + d.getMinutes();
  const [fh, fm] = c.from.split(':').map(Number), [th, tm] = c.to.split(':').map(Number);
  const from = fh * 60 + fm, to = th * 60 + tm;
  const crosses = to < from;
  const inWindow = crosses ? (mins >= from || mins < to) : (mins >= from && mins < to);
  // After midnight a window that started yesterday belongs to yesterday's weekday.
  let day = d.getDay();
  if (crosses && mins < to) day = (day + 6) % 7;
  const dayOk = !c.days || c.days.includes(day);
  return { type: 'time', met: inWindow && dayOk };
}

/**
 * @param {object} def - a validated definition
 * @param {object} metrics - getCurrentMetrics()
 * @param {number} nowMs
 * @param {boolean} wasActive - the conditions held at the last evaluation (applies each margin)
 * @returns {{ met: boolean|null, parts: object[] }}
 */
function evaluateConditions(def, metrics, nowMs, wasActive) {
  const nowS = Math.floor(nowMs / 1000);
  const parts = def.when.map(c => (c.type === 'time' ? timePart(c, nowMs) : metricPart(c, def, metrics, nowS, wasActive)));
  const r = parts.map(p => p.met);
  let met;
  if (def.join === 'any') met = r.includes(true) ? true : (r.every(x => x === false) ? false : null);
  else met = r.includes(false) ? false : (r.every(x => x === true) ? true : null);
  return { met, parts };
}

module.exports = { evaluateConditions, CLOCK_FLOOR_S };
