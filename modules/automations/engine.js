'use strict';
/**
 * modules/automations/engine.js — runs automations.
 *
 * State-based: an automation says what the settings should be while its
 * conditions hold ("then") and optionally while they don't ("else"). Each
 * tick the engine decides which branch applies, reads each step's target,
 * and sends a change only when the target is not already as wanted. So a
 * missed write is retried, a restart needs no catch-up, and nothing is sent
 * twice. It does nothing when a condition's data is missing or too old.
 *
 * All outside effects come in through `deps` so tests drive it with a fake
 * clock and fake devices (see index.js for the real wiring):
 *   now() getMetrics() catalog() list() readCurrent(entry) send(entry, step, current, a)
 *   logRun(run) notify(type, fields) paused()
 */
const { evaluateConditions } = require('./evaluate');

const MAX_TRIES = 4;
const VERIFY_DEVICE_MS = 300000;   // inverter/BMS settings are re-read this often
const VERIFY_METRIC_MS = 30000;    // switches report back through their polled metric
const CONFIRM_METRIC_MS = 45000;   // wait for a Tuya/MQTT/HA switch to show its new state before judging a send
const RETRY_MS = 60000, RETRY_MAX_MS = 600000;

const ON = new Set(['on', 'true', '1', 'yes', 'open']), OFF = new Set(['off', 'false', '0', 'no', 'closed']);
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  const t = String(v).trim().toLowerCase();
  return ON.has(t) ? true : OFF.has(t) ? false : null;
}
function same(a, b) {
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-6;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
const wantedOf = step => (step.op === 'on' ? true : step.op === 'off' ? false : step.value);
const wantedText = step => (step.op === 'set' ? String(step.value) : step.op);

function createEngine(deps) {
  const states = new Map();   // automation id → { version, active, trueSince, branch, steps[] }
  let running = false;

  const labelOf = (entry, step) => `${entry ? entry.label : step.target.entity} (${step.target.device})`;

  /** { known, value } for a step's target. */
  async function currentOf(entry, step, def, metrics, nowMs) {
    let raw;
    if (entry.source === 'device') {
      const r = await deps.readCurrent(entry);
      if (!r || r.error || r.value === undefined || r.value === null) return { known: false, error: r && r.error };
      raw = r.value;
    } else {
      const m = entry.metric && metrics[entry.metric];
      if (!m || m.value === undefined || m.value === null) return { known: false };
      if (nowMs - Number(m.timestamp) > def.max_age_s * 1000) return { known: false };
      raw = m.value;
    }
    if (step.op === 'set') return { known: true, value: raw };
    const b = asBool(raw);
    return b === null ? { known: false } : { known: true, value: b };
  }
  const matches = (step, cur) => cur.known && (step.op === 'set' ? same(cur.value, step.value) : cur.value === wantedOf(step));

  function stateFor(a) {
    let st = states.get(a.id);
    if (!st || st.version !== a.updated_at) { st = { version: a.updated_at, active: false, trueSince: 0, branch: null, steps: [], note: '' }; states.set(a.id, st); }
    return st;
  }

  async function runOne(a, metrics, nowMs, catalog) {
    const st = stateFor(a);
    const res = evaluateConditions(a, metrics, nowMs, st.active);
    st.parts = res.parts;
    if (res.met === null) { st.trueSince = 0; st.note = (res.parts.find(p => p.met === null) || {}).reason || 'Waiting for data'; return; }
    st.note = '';
    if (res.met) {
      if (!st.active) {
        if (!st.trueSince) st.trueSince = nowMs;
        if (nowMs - st.trueSince < a.for_s * 1000) { st.note = `Conditions met; waiting ${a.for_s} s`; return; }
        st.active = true;
      }
    } else { st.trueSince = 0; st.active = false; }

    const branch = st.active ? 'then' : 'else';
    if (branch !== st.branch) { st.branch = branch; st.steps = []; }
    const steps = a[branch] || [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const ss = st.steps[i] || (st.steps[i] = { nextCheck: 0, tries: 0, gaveUp: false, ok: false, sent: false });
      if (ss.gaveUp) break;
      if (nowMs < ss.nextCheck) { if (ss.ok || ss.sentOk) continue; break; }
      const entry = catalog.find(c => c.source === step.target.source && c.device === step.target.device && c.entity === step.target.entity);
      if (!entry) { ss.nextCheck = nowMs + RETRY_MS; fail(a, branch, i, step, null, 'That device or setting is no longer available'); break; }
      const cur = await currentOf(entry, step, a, metrics, nowMs);
      if (matches(step, cur)) { ss.ok = true; ss.sentOk = false; ss.tries = 0; ss.nextCheck = nowMs + (entry.source === 'device' ? VERIFY_DEVICE_MS : VERIFY_METRIC_MS); continue; }
      if (!cur.known && ss.sent && entry.source !== 'device') { ss.nextCheck = nowMs + VERIFY_METRIC_MS; continue; }   // cannot read it back: trust the earlier send
      if (ss.tries >= MAX_TRIES) {
        ss.gaveUp = true;
        fail(a, branch, i, step, entry, `Gave up after ${MAX_TRIES} attempts; it will try again when the conditions change`, true);
        break;
      }
      let result;
      try { result = await deps.send(entry, step, cur, a); } catch (e) { result = { ok: false, error: e.message }; }
      ss.tries++; ss.sent = true; ss.ok = false;
      if (result.ok) {
        ss.sentOk = true;
        ss.nextCheck = nowMs + (entry.source === 'device' ? VERIFY_DEVICE_MS : CONFIRM_METRIC_MS);
        deps.logRun({ automationId: a.id, name: a.name, branch, step: i, target: labelOf(entry, step), wanted: wantedText(step), outcome: 'done', detail: result.unchanged ? 'Already set' : '' });
        if (!result.unchanged) deps.notify('automation.ran', { title: `Automation "${a.name}" ran`, message: `${labelOf(entry, step)} → ${wantedText(step)}`, subject: String(a.id), severity: 'info' });
        continue;
      }
      ss.sentOk = false;
      ss.nextCheck = nowMs + Math.min(RETRY_MS * ss.tries, RETRY_MAX_MS);
      fail(a, branch, i, step, entry, result.error || 'The change failed');
      break;
    }
  }

  function fail(a, branch, i, step, entry, detail, final) {
    deps.logRun({ automationId: a.id, name: a.name, branch, step: i, target: labelOf(entry, step), wanted: wantedText(step), outcome: 'failed', detail });
    const st = states.get(a.id);
    if (final || st.steps[i].tries <= 1) {
      deps.notify('automation.failed', { title: `Automation "${a.name}" could not make a change`, message: `${labelOf(entry, step)} → ${wantedText(step)}: ${detail}`, subject: String(a.id), severity: 'warning' });
    }
  }

  /** One pass over every enabled automation, one at a time so writes never overlap. */
  async function tick() {
    if (running) return { skipped: 'busy' };
    running = true;
    try {
      if (deps.paused()) return { skipped: 'paused' };
      const nowMs = deps.now();
      const autos = deps.list().filter(a => a.enabled);
      if (!autos.length) return { ran: 0 };
      const metrics = deps.getMetrics();
      const catalog = deps.catalog();
      for (const a of autos) {
        try { await runOne(a, metrics, nowMs, catalog); } catch (e) { states.get(a.id) && (states.get(a.id).note = `Error: ${e.message}`); deps.error && deps.error(a, e); }
      }
      return { ran: autos.length };
    } finally { running = false; }
  }

  /** What would happen right now, without sending anything. */
  async function dryRun(def) {
    const nowMs = deps.now();
    const metrics = deps.getMetrics(), catalog = deps.catalog();
    const res = evaluateConditions(def, metrics, nowMs, false);
    const branch = res.met === null ? null : (res.met ? 'then' : 'else');
    const steps = [];
    for (const step of branch ? (def[branch] || []) : []) {
      const entry = catalog.find(c => c.source === step.target.source && c.device === step.target.device && c.entity === step.target.entity);
      if (!entry) { steps.push({ target: step.target.entity, wanted: wantedText(step), error: 'not available' }); continue; }
      const cur = await currentOf(entry, step, def, metrics, nowMs);
      steps.push({ target: labelOf(entry, step), wanted: wantedText(step), current: cur.known ? cur.value : null, wouldSend: !matches(step, cur) });
    }
    return { met: res.met, parts: res.parts, branch, steps, forSeconds: def.for_s };
  }

  const status = id => { const s = states.get(id); return s ? { active: s.active, branch: s.branch, note: s.note, pending: !!s.trueSince && !s.active } : null; };
  const reset = () => states.clear();
  return { tick, dryRun, status, reset };
}

module.exports = { createEngine, MAX_TRIES, VERIFY_DEVICE_MS, VERIFY_METRIC_MS, CONFIRM_METRIC_MS };
