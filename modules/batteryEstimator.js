'use strict';
/**
 * Battery estimator: state of charge by counting the battery current, for
 * inverters with no link to the battery's BMS (their own SOC is a guess from
 * voltage, and a poor one for lithium).
 *
 * Settings (config `battery_estimator`, Settings > Metrics):
 *   capacity_ah, chemistry ('lifepo4' | 'lead_acid'), nominal_voltage (12/24/48),
 *   current_inputs   battery current readings, A, + while charging: one per
 *                    inverter on the bank (they each see only their share)
 *   voltage_inputs   battery voltage readings (averaged)
 *   charge_efficiency, full_voltage, tail_current_a, full_minutes,
 *   empty_enabled, empty_voltage, empty_soc, use_for_role
 * Anything left empty takes the chemistry's default.
 *
 * Each stored sample of each current input is counted (trapezoid between
 * samples), so nothing between poll cycles is missed; a gap longer than
 * MAX_GAP_S is not guessed at, and is shown as time not counted. Charging
 * counts at charge_efficiency. The count is set to 100% when the battery is
 * plainly full: voltage at or above full_voltage with the current within
 * tail_current_a either way, for full_minutes. Optionally it is set to
 * empty_soc when the voltage sits at empty_voltage under a light load. Until
 * the first full charge it starts from a guess from the voltage.
 *
 * Writes battery_soc_estimate (%) and battery_remaining_ah (Ah) every cycle,
 * before combined metrics, so they can use it.
 *
 * @module batteryEstimator
 */
const { getDb, getConfig, setConfig, queueMetricValue, flushMetrics } = require('./database');
const { logger } = require('./logger');

const CONFIG_KEY = 'battery_estimator';
const STATE_KEY = 'battery_estimator_state';
const OUT_SOC = 'battery_soc_estimate';
const OUT_AH = 'battery_remaining_ah';
const MAX_GAP_S = 180;       // longer between two samples of one input: not counted
const FRESH_S = 180;         // an input's newest sample older than this: missing
const LIGHT_LOAD_C = 0.05;   // "light load" for the empty check: up to 5% of capacity, A
const EMPTY_MINUTES = 5;
const MAX_INPUTS = 8;
const NAME_RE = /^[A-Za-z0-9_.:\- ()%]{1,80}$/;

// Per cell: resting voltage -> SOC %, and defaults scaled by the cell count.
const CHEMISTRY = {
  lifepo4: {
    label: 'Lithium iron phosphate (LiFePO4)', cells: { 12: 4, 24: 8, 48: 16 }, efficiency: 0.99,
    full_cell: 3.45, tail_pct: 4, full_minutes: 10, empty_cell: 3.0, empty_soc: 5,
    curve: [[2.8, 0], [3.0, 5], [3.15, 10], [3.2, 20], [3.25, 30], [3.27, 40], [3.29, 50], [3.3, 60], [3.32, 70], [3.33, 80], [3.35, 90], [3.4, 97], [3.45, 100]]
  },
  lead_acid: {
    label: 'Lead-acid (flooded, AGM, gel)', cells: { 12: 6, 24: 12, 48: 24 }, efficiency: 0.85,
    full_cell: 2.35, tail_pct: 2, full_minutes: 15, empty_cell: 1.95, empty_soc: 20,
    curve: [[1.75, 0], [1.918, 10], [1.943, 20], [1.968, 30], [1.993, 40], [2.017, 50], [2.04, 60], [2.062, 70], [2.083, 80], [2.103, 90], [2.122, 100]]
  }
};

let lastStatus = null;

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
function readJson(key) {
  try { return JSON.parse(getConfig(key) || 'null'); } catch (_) { return null; }
}
function names(list) {
  return (Array.isArray(list) ? list : String(list || '').split(','))
    .map(s => String(s).trim()).filter(s => NAME_RE.test(s)).filter((s, i, a) => a.indexOf(s) === i).slice(0, MAX_INPUTS);
}

/** The saved settings with every default filled in. */
function settings(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const chemistry = CHEMISTRY[c.chemistry] ? c.chemistry : 'lifepo4';
  const k = CHEMISTRY[chemistry];
  const nominal = [12, 24, 48].includes(Number(c.nominal_voltage)) ? Number(c.nominal_voltage) : 48;
  const cells = k.cells[nominal];
  const capacity = Number(c.capacity_ah) > 0 ? Number(c.capacity_ah) : 0;
  const current = names(c.current_inputs), voltage = names(c.voltage_inputs);
  const enabled = !!c.enabled && capacity > 0 && current.length > 0;
  return {
    enabled, chemistry, nominal_voltage: nominal, cells, capacity_ah: capacity,
    current_inputs: current, voltage_inputs: voltage,
    charge_efficiency: Math.min(1, Math.max(0.5, num(c.charge_efficiency, k.efficiency))),
    full_voltage: num(c.full_voltage, round(k.full_cell * cells, 2)),
    tail_current_a: Math.max(0, num(c.tail_current_a, round(capacity * k.tail_pct / 100, 1))),
    full_minutes: Math.max(1, num(c.full_minutes, k.full_minutes)),
    empty_enabled: c.empty_enabled !== false,
    empty_voltage: num(c.empty_voltage, round(k.empty_cell * cells, 2)),
    empty_soc: Math.min(50, Math.max(0, num(c.empty_soc, k.empty_soc))),
    use_for_role: enabled && !!c.use_for_role
  };
}

/** Rough SOC % from a resting battery voltage (under load it reads low). */
function socFromVoltage(volts, chemistry, cells) {
  const curve = (CHEMISTRY[chemistry] || CHEMISTRY.lifepo4).curve;
  const v = volts / cells;
  if (v <= curve[0][0]) return 0;
  for (let i = 1; i < curve.length; i++) {
    const [v1, s1] = curve[i], [v0, s0] = curve[i - 1];
    if (v <= v1) return round(s0 + (s1 - s0) * (v - v0) / (v1 - v0), 1);
  }
  return 100;
}

/**
 * One step: count the new samples and apply the full/empty checks.
 * @param {object} cfg     settings()
 * @param {object} prev    saved state
 * @param {{samples: Object<string, Array<{t:number, v:number}>>, voltage: number|null}} data
 * @param {number} now     seconds
 * @returns {{state: object, status: object}}
 */
function advance(cfg, prev, data, now) {
  const cap = cfg.capacity_ah;
  const s = { ...(prev || {}), last: { ...((prev && prev.last) || {}) } };
  // A changed capacity keeps the same percentage.
  if (s.ah != null && Number(s.capacity) > 0 && s.capacity !== cap) s.ah = s.ah / s.capacity * cap;
  s.capacity = cap;
  const counting = s.ah != null;
  let added = 0, current = 0, gap = 0;
  const missing = [];
  for (const name of cfg.current_inputs) {
    let last = s.last[name];
    const list = (data.samples[name] || []).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
    for (const p of list) {
      if (last && p.t <= last.t) continue;
      if (last && counting) {
        const dt = p.t - last.t;
        if (dt <= MAX_GAP_S) {
          let ah = (last.v + p.v) / 2 * dt / 3600;
          if (ah > 0) ah *= cfg.charge_efficiency;
          added += ah;
        } else {
          gap = Math.max(gap, dt);
        }
      }
      last = { t: p.t, v: p.v };
    }
    if (last) s.last[name] = last;
    if (!last || now - last.t > FRESH_S) missing.push(name);
    else current += last.v;
  }
  const v = Number.isFinite(data.voltage) ? data.voltage : null;

  if (!counting) {
    if (v == null) return { state: s, status: { waiting: 'battery voltage', missing } };
    s.ah = cap * socFromVoltage(v, cfg.chemistry, cfg.cells) / 100;
    s.origin = 'voltage'; s.originAt = now; s.uncounted = 0;
  } else {
    s.ah = Math.min(cap, Math.max(0, s.ah + added));
    s.uncounted = (s.uncounted || 0) + gap;
  }

  const settled = v != null && !missing.length;
  if (settled && v >= cfg.full_voltage && Math.abs(current) <= cfg.tail_current_a) {
    s.fullSince = s.fullSince || now;
    if (now - s.fullSince >= cfg.full_minutes * 60) {
      s.ah = cap; s.lastFull = now; s.origin = 'full'; s.originAt = now; s.uncounted = 0;
    }
  } else {
    s.fullSince = null;
  }
  if (cfg.empty_enabled && settled && v <= cfg.empty_voltage && current <= 0 && -current <= cap * LIGHT_LOAD_C) {
    s.emptySince = s.emptySince || now;
    const target = cap * cfg.empty_soc / 100;
    if (now - s.emptySince >= EMPTY_MINUTES * 60 && Math.abs(s.ah - target) > cap * 0.02) {
      s.ah = target; s.lastEmpty = now; s.origin = 'empty'; s.originAt = now; s.uncounted = 0;
    }
  } else {
    s.emptySince = null;
  }

  return {
    state: s,
    status: {
      soc: round(s.ah / cap * 100, 1), ah: round(s.ah, 1), current: missing.length ? null : round(current, 2), voltage: v == null ? null : round(v, 2),
      missing, origin: s.origin, origin_at: s.originAt || null, last_full: s.lastFull || null, last_empty: s.lastEmpty || null,
      uncounted_s: Math.round(s.uncounted || 0), full_for_s: s.fullSince ? now - s.fullSince : 0
    }
  };
}

/** Newest fresh voltage readings, averaged. */
function readVoltage(db, list, now) {
  const stmt = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?');
  const vals = [];
  for (const name of list) {
    const r = stmt.get(name);
    if (r && Number.isFinite(Number(r.value)) && now - Number(r.timestamp) <= FRESH_S) vals.push(Number(r.value));
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** One poll cycle. */
function runBatteryEstimator(now = Math.floor(Date.now() / 1000)) {
  const cfg = settings(readJson(CONFIG_KEY));
  if (!cfg.enabled) { lastStatus = null; return { written: 0 }; }
  flushMetrics();
  const db = getDb();
  const prev = readJson(STATE_KEY) || {};
  const q = db.prepare('SELECT timestamp AS t, value AS v FROM metrics WHERE metric = ? AND timestamp > ? AND value IS NOT NULL ORDER BY timestamp LIMIT 5000');
  const samples = {};
  for (const name of cfg.current_inputs) {
    const since = prev.last && prev.last[name] ? prev.last[name].t : now - MAX_GAP_S;
    samples[name] = q.all(name, since).map(r => ({ t: Number(r.t), v: Number(r.v) }));
  }
  const { state, status } = advance(cfg, prev, { samples, voltage: readVoltage(db, cfg.voltage_inputs, now) }, now);
  setConfig(STATE_KEY, JSON.stringify(state));
  if (prev.origin !== state.origin && state.origin === 'full') logger.info(`[battery] full: estimate set to 100%`);
  if (prev.origin !== state.origin && state.origin === 'empty') logger.info(`[battery] low voltage under light load: estimate set to ${cfg.empty_soc}%`);
  lastStatus = { ...status, at: now };
  if (status.soc == null) return { written: 0 };
  queueMetricValue(OUT_SOC, status.soc, now, '%');
  queueMetricValue(OUT_AH, status.ah, now, 'Ah');
  return { written: 2 };
}

/** Settings > Metrics: set the estimate by hand (e.g. from the BMS's own app). */
function setSoc(soc, now = Math.floor(Date.now() / 1000)) {
  const cfg = settings(readJson(CONFIG_KEY));
  if (!cfg.capacity_ah) throw new Error('Set the battery capacity first.');
  const pct = Number(soc);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Charge must be 0 to 100%.');
  const s = readJson(STATE_KEY) || {};
  Object.assign(s, { ah: cfg.capacity_ah * pct / 100, capacity: cfg.capacity_ah, origin: 'manual', originAt: now, uncounted: 0, fullSince: null, emptySince: null });
  setConfig(STATE_KEY, JSON.stringify(s));
  lastStatus = { ...(lastStatus || {}), soc: round(pct, 1), ah: round(s.ah, 1), origin: 'manual', origin_at: now, uncounted_s: 0 };
  return lastStatus;
}

function getStatus() { return lastStatus; }

/** Battery current and voltage readings of the enabled inverters, for the settings form. */
function suggestions() {
  const out = { current_inputs: [], voltage_inputs: [] };
  let dongles = [];
  try { dongles = JSON.parse(getConfig('dongle_config') || '[]'); } catch (_) { dongles = []; }
  const { profileNames } = require('./inverterNames');
  for (const d of Array.isArray(dongles) ? dongles : []) {
    if (!d || !d.enabled || !d.mappings) continue;
    const map = profileNames(d.profile);
    if (!map) continue;
    for (const [key, handle] of Object.entries(d.mappings)) {
      const base = map.get(String(handle));
      if (base === 'battery_net_current') out.current_inputs.push(key);
      if (base === 'battery_voltage') out.voltage_inputs.push(key);
    }
  }
  return out;
}

/** Save from Settings; points the Battery % role at the estimate, or back. */
function saveSettings(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Expected battery settings.');
  const clean = {
    enabled: !!raw.enabled, chemistry: CHEMISTRY[raw.chemistry] ? raw.chemistry : 'lifepo4',
    nominal_voltage: [12, 24, 48].includes(Number(raw.nominal_voltage)) ? Number(raw.nominal_voltage) : 48,
    capacity_ah: Number(raw.capacity_ah), current_inputs: names(raw.current_inputs), voltage_inputs: names(raw.voltage_inputs),
    empty_enabled: raw.empty_enabled !== false, use_for_role: !!raw.use_for_role
  };
  if (clean.enabled && !(clean.capacity_ah > 0 && clean.capacity_ah <= 100000)) throw new Error('Enter the battery capacity in Ah.');
  if (clean.enabled && !clean.current_inputs.length) throw new Error('Pick at least one battery current reading.');
  if (clean.enabled && !clean.voltage_inputs.length) throw new Error('Pick a battery voltage reading.');
  for (const k of ['charge_efficiency', 'full_voltage', 'tail_current_a', 'full_minutes', 'empty_voltage', 'empty_soc']) {
    if (raw[k] === '' || raw[k] == null) continue;
    if (!Number.isFinite(Number(raw[k])) || Number(raw[k]) < 0) throw new Error(`${k.replace(/_/g, ' ')} must be a number.`);
    clean[k] = Number(raw[k]);
  }
  if (clean.charge_efficiency !== undefined && (clean.charge_efficiency < 0.5 || clean.charge_efficiency > 1)) throw new Error('Charge efficiency must be 0.5 to 1.');
  const old = readJson(CONFIG_KEY) || {};
  clean.previous_role = old.previous_role;
  const eff = settings(clean);
  let roles = {};
  try { roles = JSON.parse(getConfig('role_metrics') || '{}') || {}; } catch (_) { roles = {}; }
  let rolesChanged = false;
  if (eff.use_for_role && roles.battery_soc !== OUT_SOC) {
    clean.previous_role = roles.battery_soc || '';
    roles.battery_soc = OUT_SOC; rolesChanged = true;
  } else if (!eff.use_for_role && roles.battery_soc === OUT_SOC) {
    if (clean.previous_role) roles.battery_soc = clean.previous_role; else delete roles.battery_soc;
    rolesChanged = true;
  }
  getDb().transaction(() => {
    setConfig(CONFIG_KEY, JSON.stringify(clean));
    if (rolesChanged) setConfig('role_metrics', JSON.stringify(roles));
    // List the outputs with their units, so pickers and the data-spike guard know them.
    let list = [];
    try { list = JSON.parse(getConfig('user_metrics') || '[]'); } catch (_) { list = []; }
    if (eff.enabled && Array.isArray(list)) {
      let added = false;
      for (const [name, unit] of [[OUT_SOC, '%'], [OUT_AH, 'Ah']]) {
        if (!list.some(m => m && m.name === name)) { list.push({ name, unit, createdAt: Date.now() }); added = true; }
      }
      if (added) setConfig('user_metrics', JSON.stringify(list));
    }
  })();
  return clean;
}

module.exports = {
  runBatteryEstimator, advance, settings, socFromVoltage, setSoc, getStatus, suggestions, saveSettings,
  CHEMISTRY, CONFIG_KEY, STATE_KEY, OUT_SOC, OUT_AH, MAX_GAP_S
};
