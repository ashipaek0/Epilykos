'use strict';
/**
 * modules/automations/definition.js — what an automation is, and checking one (pure).
 *
 *   { name, enabled, join: 'all'|'any', for_s, max_age_s,
 *     when: [ metric condition | time window ],
 *     then: [ step ], else: [ step ] (optional) }
 *
 *   metric condition  { type:'metric', metric, operator: gt|gte|lt|lte|eq|neq, value, hysteresis?, max_age_s? }
 *   time window       { type:'time', from:'HH:MM', to:'HH:MM', days?: [0..6] }   (0 = Sunday; to < from crosses midnight)
 *   step              { target:{source,device,entity}, op:'on'|'off'|'set', value? }
 *
 * "then" is what the settings should be while the conditions hold; "else"
 * (optional) is what they should be when they don't. Several steps make one
 * action (e.g. grid charging is three settings): they run in order.
 */
const { findTarget } = require('./catalog');

const OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const MAX_CONDITIONS = 6, MAX_STEPS = 10;
const DEFAULT_MAX_AGE_S = 900;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const toNum = v => (isNum(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

function checkStep(step, catalog, where, errors) {
  const entry = step && findTarget(catalog, step.target);
  if (!entry) { errors.push(`${where}: that device or setting is not available`); return null; }
  if (!entry.ops.includes(step.op)) { errors.push(`${where}: ${entry.label} cannot be ${step.op === 'set' ? 'set to a value' : 'turned ' + step.op}`); return null; }
  const out = { target: { source: entry.source, device: entry.device, entity: entry.entity }, op: step.op };
  if (step.op !== 'set') return out;
  const v = step.value;
  if (entry.kind === 'number') {
    const n = toNum(v);
    if (n === null) { errors.push(`${where}: ${entry.label} needs a number`); return null; }
    if (isNum(entry.min) && isNum(entry.max) && (n < entry.min || n > entry.max)) { errors.push(`${where}: ${entry.label} must be between ${entry.min} and ${entry.max}`); return null; }
    if (entry.step > 0 && isNum(entry.min) && Math.abs((n - entry.min) / entry.step - Math.round((n - entry.min) / entry.step)) > 1e-6) { errors.push(`${where}: ${entry.label} goes in steps of ${entry.step}`); return null; }
    out.value = n;
  } else if (entry.kind === 'select') {
    if (!entry.options.some(o => o.value === String(v))) { errors.push(`${where}: choose one of the listed values for ${entry.label}`); return null; }
    out.value = Number.isFinite(Number(v)) ? Number(v) : String(v);
  } else {
    if (v === undefined || v === null || v === '' || typeof v === 'object') { errors.push(`${where}: give a value for ${entry.label}`); return null; }
    out.value = typeof v === 'boolean' || isNum(v) ? v : String(v).slice(0, 200);
  }
  return out;
}

/** @returns {{ ok: boolean, errors: string[], def: object|null }} def is the cleaned copy */
function validateDefinition(input, catalog) {
  const errors = [];
  const d = input && typeof input === 'object' ? input : {};
  const name = typeof d.name === 'string' ? d.name.trim().slice(0, 80) : '';
  if (!name) errors.push('Give the automation a name');
  const def = { name, enabled: d.enabled === true, join: d.join === 'any' ? 'any' : 'all', for_s: 0, max_age_s: DEFAULT_MAX_AGE_S, when: [], then: [], else: [] };
  if (d.for_s !== undefined && d.for_s !== null && d.for_s !== '') {
    const n = toNum(d.for_s);
    if (n === null || n < 0 || n > 86400) errors.push('"For how long" must be 0 to 86400 seconds'); else def.for_s = Math.round(n);
  }
  if (d.max_age_s !== undefined && d.max_age_s !== null && d.max_age_s !== '') {
    const n = toNum(d.max_age_s);
    if (n === null || n < 60 || n > 172800) errors.push('"Ignore data older than" must be 60 to 172800 seconds'); else def.max_age_s = Math.round(n);
  }
  const when = Array.isArray(d.when) ? d.when : [];
  if (!when.length) errors.push('Add at least one condition');
  if (when.length > MAX_CONDITIONS) errors.push(`At most ${MAX_CONDITIONS} conditions`);
  when.slice(0, MAX_CONDITIONS).forEach((c, i) => {
    const where = `Condition ${i + 1}`;
    if (c && c.type === 'time') {
      if (!HHMM.test(c.from) || !HHMM.test(c.to)) return errors.push(`${where}: use times like 07:30`);
      if (c.from === c.to) return errors.push(`${where}: start and end are the same`);
      const t = { type: 'time', from: c.from, to: c.to };
      if (c.days !== undefined && c.days !== null) {
        if (!Array.isArray(c.days) || !c.days.every(x => Number.isInteger(x) && x >= 0 && x <= 6)) return errors.push(`${where}: days are 0 (Sunday) to 6`);
        if (c.days.length && c.days.length < 7) t.days = [...new Set(c.days)].sort();
      }
      def.when.push(t);
    } else if (c && c.type === 'metric') {
      if (typeof c.metric !== 'string' || !c.metric) return errors.push(`${where}: choose a metric`);
      if (!OPERATORS.includes(c.operator)) return errors.push(`${where}: choose a comparison`);
      const m = { type: 'metric', metric: c.metric, operator: c.operator };
      if (c.operator === 'eq' || c.operator === 'neq') {
        if (c.value === undefined || c.value === null || c.value === '' || typeof c.value === 'object') return errors.push(`${where}: give a value`);
        m.value = toNum(c.value) !== null ? toNum(c.value) : String(c.value).slice(0, 100);
      } else {
        const n = toNum(c.value);
        if (n === null) return errors.push(`${where}: the value must be a number`);
        m.value = n;
      }
      if (c.hysteresis !== undefined && c.hysteresis !== null && c.hysteresis !== '') {
        const h = toNum(c.hysteresis);
        if (h === null || h < 0) return errors.push(`${where}: the margin must be a number from 0`);
        if (h) m.hysteresis = h;
      }
      if (c.max_age_s !== undefined && c.max_age_s !== null && c.max_age_s !== '') {
        const n = toNum(c.max_age_s);
        if (n === null || n < 60 || n > 172800) return errors.push(`${where}: data age must be 60 to 172800 seconds`);
        m.max_age_s = Math.round(n);
      }
      def.when.push(m);
    } else errors.push(`${where}: unknown kind of condition`);
  });
  for (const branch of ['then', 'else']) {
    const steps = Array.isArray(d[branch]) ? d[branch] : [];
    if (steps.length > MAX_STEPS) errors.push(`At most ${MAX_STEPS} actions in "${branch}"`);
    steps.slice(0, MAX_STEPS).forEach((s, i) => { const c = checkStep(s, catalog, `${branch === 'then' ? 'Then' : 'Otherwise'} action ${i + 1}`, errors); if (c) def[branch].push(c); });
  }
  if (!(Array.isArray(d.then) && d.then.length)) errors.push('Add at least one "then" action');
  return { ok: errors.length === 0, errors, def: errors.length ? null : def };
}

module.exports = { validateDefinition, OPERATORS, DEFAULT_MAX_AGE_S, MAX_STEPS, MAX_CONDITIONS };
