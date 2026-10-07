'use strict';
/**
 * Combined metrics: new metrics computed from existing ones, from any source.
 *
 * Each definition (config `combined_metrics`, edited in Settings > Metrics):
 *   { id, name, unit, enabled, fn, inputs: [metric names], ... }
 *
 * fn:
 *   sum, mean, min, max      over the inputs (e.g. four MPPT powers -> PV total)
 *   difference               first input minus the others
 *   product                  inputs multiplied (e.g. voltage x current -> power)
 *   weighted_mean            inputs weighted by `weights` (e.g. SoC by capacity)
 *   scale                    first input x `factor` + `offset`
 *   energy_today             kWh today from power, integrated over time, reset
 *                            at local midnight (inputs summed first; `input_unit`
 *                            'W' or 'kW')
 *   energy_total             lifetime kWh from power (never resets; `start`
 *                            sets the starting value)
 *   counter_today            today's increase of a lifetime counter
 *
 * An input counts only while it is fresh (updated within `stale_seconds`,
 * default 300). With `missing: 'skip'` (default) nothing is written while any
 * input is stale or missing, so a sum never quietly drops an inverter; with
 * 'zero' a missing input counts as 0. Energy pauses across gaps longer than
 * 10 minutes rather than guessing what happened.
 *
 * Runs every poll cycle, before the history table is filled, so a role mapped
 * to a combined metric gets this cycle's value. Definitions may use other
 * combined metrics; they run in dependency order and cycles are refused.
 *
 * @module combinedMetrics
 */

const { getDb, getConfig, setConfig, queueMetricValue, flushMetrics } = require('./database');
const { logger } = require('./logger');
const { localDateString } = require('./localTime');

const CONFIG_KEY = 'combined_metrics';
const STATE_KEY = 'combined_metrics_state';
const FNS = ['sum', 'mean', 'min', 'max', 'difference', 'product', 'weighted_mean', 'scale', 'energy_today', 'energy_total', 'counter_today'];
const ENERGY_FNS = new Set(['energy_today', 'energy_total']);
const MAX_GAP_SECONDS = 600;
const MAX_INPUTS = 64;   // e.g. 6 inverters x 4 MPPTs fits with room to spare
const NAME_RE = /^[A-Za-z0-9_.:\- ()%]+$/;

function loadDefinitions() {
  try { const v = JSON.parse(getConfig(CONFIG_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
function loadState() {
  try { const v = JSON.parse(getConfig(STATE_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

/** Problems with one definition, as plain sentences ([] when fine). */
function validateDefinition(def, others = []) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['Definition must be an object.'];
  const name = String(def.name || '').trim();
  if (!name) errors.push('Give the combined metric a name.');
  else if (!NAME_RE.test(name) || name.length > 64) errors.push('Name: up to 64 letters, numbers, spaces and _ . : - ( ) %.');
  if (others.some(o => o && o.id !== def.id && String(o.name || '').trim().toLowerCase() === name.toLowerCase())) errors.push(`Another combined metric is already called "${name}".`);
  if (!FNS.includes(def.fn)) errors.push('Pick what to compute.');
  const inputs = Array.isArray(def.inputs) ? def.inputs.map(s => String(s || '').trim()).filter(Boolean) : [];
  const single = ['scale', 'counter_today'].includes(def.fn);
  if (!inputs.length) errors.push('Pick at least one input metric.');
  if (inputs.length > MAX_INPUTS) errors.push(`Up to ${MAX_INPUTS} inputs (this has ${inputs.length}). Split them into groups, then add the groups together.`);
  if (new Set(inputs).size !== inputs.length) errors.push('Each input can only be used once.');
  if (single && inputs.length > 1) errors.push('This calculation takes one input.');
  if (['difference'].includes(def.fn) && inputs.length < 2) errors.push('A difference needs two or more inputs.');
  if (inputs.includes(name)) errors.push('A combined metric cannot use itself as an input.');
  if (def.fn === 'weighted_mean') {
    const w = Array.isArray(def.weights) ? def.weights : [];
    if (w.length !== inputs.length || !w.every(x => Number.isFinite(Number(x)) && Number(x) >= 0) || !w.some(x => Number(x) > 0)) errors.push('Give each input a weight of 0 or more (at least one above 0).');
  }
  if (def.fn === 'scale' && (!Number.isFinite(Number(def.factor ?? 1)) || !Number.isFinite(Number(def.offset ?? 0)))) errors.push('Factor and offset must be numbers.');
  if (ENERGY_FNS.has(def.fn) && def.input_unit && !['W', 'kW'].includes(def.input_unit)) errors.push('Input unit must be W or kW.');
  if (def.stale_seconds != null && def.stale_seconds !== '' && !(Number(def.stale_seconds) >= 10 && Number(def.stale_seconds) <= 86400)) errors.push('Stale after: 10 seconds to 1 day.');
  if (def.missing && !['skip', 'zero'].includes(def.missing)) errors.push('Missing inputs: skip or count as zero.');
  return errors;
}

/** Definitions in an order where each runs after the combined metrics it uses; cycles are dropped. */
function orderDefinitions(defs) {
  const byName = new Map(defs.map(d => [String(d.name).trim(), d]));
  const out = [], state = new Map(), cyclic = new Set();
  const visit = (d, stack) => {
    const key = String(d.name).trim();
    if (state.get(key) === 'done') return true;
    if (state.get(key) === 'busy') { stack.forEach(n => cyclic.add(n)); return false; }
    state.set(key, 'busy');
    let ok = true;
    for (const input of d.inputs || []) { const dep = byName.get(String(input).trim()); if (dep && !visit(dep, [...stack, key])) ok = false; }
    state.set(key, 'done');
    if (ok && !cyclic.has(key)) out.push(d);
    return ok;
  };
  defs.forEach(d => visit(d, []));
  return { ordered: out.filter(d => !cyclic.has(String(d.name).trim())), cyclic: [...cyclic] };
}

/**
 * Compute one definition. `read(name)` returns { value, timestamp } or null.
 * Returns { value } to write, or { skip: reason }.
 */
function evaluate(def, read, prevState, now) {
  const stale = Number(def.stale_seconds) >= 10 ? Number(def.stale_seconds) : 300;
  const zeroMissing = def.missing === 'zero';
  const inputs = (def.inputs || []).map(s => String(s).trim()).filter(Boolean);
  const vals = [];
  for (const name of inputs) {
    const r = read(name);
    const fresh = r && Number.isFinite(r.value) && now - r.timestamp <= stale;
    if (fresh) vals.push(r.value);
    else if (zeroMissing) vals.push(0);
    else return { skip: `${name} is ${r ? 'stale' : 'missing'}` };
  }
  const sum = vals.reduce((a, b) => a + b, 0);
  switch (def.fn) {
    case 'sum': return { value: sum };
    case 'mean': return { value: sum / vals.length };
    case 'min': return { value: Math.min(...vals) };
    case 'max': return { value: Math.max(...vals) };
    case 'difference': return { value: vals[0] - vals.slice(1).reduce((a, b) => a + b, 0) };
    case 'product': return { value: vals.reduce((a, b) => a * b, 1) };
    case 'weighted_mean': {
      const w = (def.weights || []).map(Number), total = w.reduce((a, b) => a + b, 0);
      return { value: vals.reduce((a, v, i) => a + v * w[i], 0) / total };
    }
    case 'scale': return { value: vals[0] * Number(def.factor ?? 1) + Number(def.offset ?? 0) };
    case 'energy_today':
    case 'energy_total': {
      const kw = def.input_unit === 'kW' ? sum : sum / 1000;
      const today = localDateString(new Date(now * 1000));
      const s = { ...(prevState || {}) };
      if (def.fn === 'energy_today' && s.day !== today) { s.day = today; s.kwh = 0; }
      if (def.fn === 'energy_total' && s.kwh == null) s.kwh = Number(def.start) || 0;
      if (s.kwh == null) s.kwh = 0;
      // Trapezoid between this reading and the last; gaps and resets add nothing.
      if (Number.isFinite(s.lastTs) && Number.isFinite(s.lastKw) && now > s.lastTs && now - s.lastTs <= MAX_GAP_SECONDS) {
        s.kwh += Math.max(0, (s.lastKw + kw) / 2) * (now - s.lastTs) / 3600;
      }
      s.lastTs = now; s.lastKw = kw;
      return { value: Math.round(s.kwh * 10000) / 10000, state: s };
    }
    case 'counter_today': {
      const today = localDateString(new Date(now * 1000));
      const s = { ...(prevState || {}) };
      if (s.day !== today || !Number.isFinite(s.base)) { s.day = today; s.base = vals[0]; s.carried = 0; }
      else if (vals[0] < s.last) {
        // The counter went down (reset or replaced): keep what today already counted.
        s.carried = (s.carried || 0) + (s.last - s.base); s.base = vals[0];
      }
      s.last = vals[0];
      return { value: Math.max(0, (s.carried || 0) + vals[0] - s.base), state: s };
    }
    default: return { skip: 'unknown calculation' };
  }
}

/** One poll cycle: compute every enabled definition and queue its value. */
function runCombinedMetrics(now = Math.floor(Date.now() / 1000)) {
  const defs = loadDefinitions().filter(d => d && d.enabled !== false && validateDefinition(d).length === 0);
  if (!defs.length) return { written: 0 };
  flushMetrics();
  const db = getDb();
  const stmt = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?');
  const computed = new Map();   // results from this cycle, for chained definitions
  const read = name => {
    if (computed.has(name)) return { value: computed.get(name), timestamp: now };
    const row = stmt.get(name);
    if (!row || row.value == null) return null;
    const ts = Number(row.timestamp) > 1e12 ? Math.floor(Number(row.timestamp) / 1000) : Number(row.timestamp);
    return { value: Number(row.value), timestamp: ts };
  };
  const { ordered, cyclic } = orderDefinitions(defs);
  if (cyclic.length) logger.warn(`[combined] skipping metrics that depend on each other: ${cyclic.join(', ')}`);
  const state = loadState();
  let written = 0, stateChanged = false;
  const status = {};
  for (const def of ordered) {
    const key = def.id || def.name;
    const result = evaluate(def, read, state[key], now);
    if (result.state) { state[key] = result.state; stateChanged = true; }
    if (result.skip) { status[key] = { ok: false, reason: result.skip, at: now }; continue; }
    if (!Number.isFinite(result.value)) { status[key] = { ok: false, reason: 'not a number', at: now }; continue; }
    computed.set(String(def.name).trim(), result.value);
    queueMetricValue(String(def.name).trim(), result.value, now);
    status[key] = { ok: true, value: result.value, at: now };
    written++;
  }
  if (stateChanged) setConfig(STATE_KEY, JSON.stringify(state));
  lastStatus = status;
  return { written, cyclic };
}

// ── Breakdowns: the parts behind a combined total, for cards that show them ──
const SPLITTABLE = new Set(['sum', 'mean', 'weighted_mean']);
const MAX_DEPTH = 4;

function parseList(key) { try { const v = JSON.parse(getConfig(key) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }

/**
 * Which source writes a metric: from each source's own mappings first, then by
 * its metric prefix. Returns (metric) => { name, prefix } or null.
 */
function sourceLookup() {
  const owners = new Map(), prefixes = [];
  for (const key of ['dongle_config', 'modbus_devices', 'rs232_devices']) {
    for (const d of parseList(key)) {
      if (!d || !d.name) continue;
      const src = { name: String(d.name).trim(), prefix: String(d.prefix || '').trim() };
      for (const m of Object.keys(d.mappings && typeof d.mappings === 'object' ? d.mappings : {})) if (!owners.has(m)) owners.set(m, src);
      if (src.prefix) prefixes.push(src);
    }
  }
  for (const d of parseList('bms_devices')) {
    if (d && d.name) prefixes.push({ name: String(d.name).trim(), prefix: `bms_${d.name}_`.replace(/[^a-zA-Z0-9_]/g, '_') });
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  return m => owners.get(m) || prefixes.find(x => m.startsWith(x.prefix)) || null;
}

const UPPER = /^(pv|mppt|ac|dc|l|bms|soc)\d*$/i;
function humanise(tokens) {
  return tokens.map((t, i) => (UPPER.test(t) ? t.toUpperCase() : i === 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t)).join(' ');
}

/**
 * Short labels for sibling parts: the source name when they come from
 * different sources, plus whatever tells them apart within one source
 * (inv1_pv1_power, inv1_pv2_power -> "PV1", "PV2"; across two inverters
 * "Phocos 1 PV1" ...). Words every part shares ("power") are left out.
 */
function partLabels(metrics, sourceOf = () => null, custom = {}) {
  const split = metrics.map(m => {
    const p = sourceOf(m);
    const rest = p && p.prefix && m.startsWith(p.prefix) ? m.slice(p.prefix.length) : m;
    return { source: p ? p.name : '', tokens: rest.split(/[_\s.]+/).filter(Boolean) };
  });
  const common = split.length > 1 ? split[0].tokens.filter(t => split.every(s => s.tokens.includes(t))) : [];
  const manySources = new Set(split.map(s => s.source)).size > 1;
  return metrics.map((m, i) => {
    if (custom[m]) return String(custom[m]);
    const s = split[i];
    const rest = humanise(s.tokens.filter(t => !common.includes(t)));
    const label = [manySources || !rest ? s.source : '', rest].filter(Boolean).join(' ');
    return label || humanise(s.tokens) || m;
  });
}

/**
 * { metrics: { [combined name]: { fn, unit, parts: [{ metric, label, parts? }] } },
 *   roles: { [role]: combined name } } for enabled sums and averages. A part
 * that is itself a combined sum or average carries its own parts.
 */
function buildBreakdowns() {
  const defs = loadDefinitions().filter(d => d && d.enabled !== false && SPLITTABLE.has(d.fn) && validateDefinition(d).length === 0);
  if (!defs.length) return { metrics: {}, roles: {} };
  const byName = new Map(defs.map(d => [String(d.name).trim(), d]));
  const sourceOf = sourceLookup();
  const tree = (def, depth, seen) => {
    const inputs = def.inputs.map(s => String(s).trim()).filter(Boolean);
    const labels = partLabels(inputs, sourceOf, def.labels && typeof def.labels === 'object' ? def.labels : {});
    return inputs.map((metric, i) => {
      const part = { metric, label: labels[i] };
      const sub = byName.get(metric);
      if (sub && depth < MAX_DEPTH && !seen.has(metric)) part.parts = tree(sub, depth + 1, new Set([...seen, metric]));
      return part;
    });
  };
  const metrics = {};
  for (const d of defs) {
    const name = String(d.name).trim();
    metrics[name] = { fn: d.fn, unit: d.unit || '', parts: tree(d, 1, new Set([name])) };
  }
  let roleMap = {}; try { roleMap = JSON.parse(getConfig('role_metrics') || '{}') || {}; } catch (_) { roleMap = {}; }
  const roles = {};
  for (const [role, name] of Object.entries(roleMap)) if (typeof name === 'string' && metrics[name.trim()]) roles[role] = name.trim();
  return { metrics, roles };
}

let lastStatus = {};
/** What each definition did on the last cycle: { [id]: { ok, value | reason, at } }. */
function getCombinedStatus() { return lastStatus; }

module.exports = { buildBreakdowns, partLabels, MAX_INPUTS, runCombinedMetrics, evaluate, validateDefinition, orderDefinitions, loadDefinitions, getCombinedStatus, FNS, CONFIG_KEY, STATE_KEY };
