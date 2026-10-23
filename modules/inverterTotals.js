/**
 * Totals across inverters of one kind.
 *
 * With two or more enabled inverters on the same profile, a site role (Solar,
 * Home use, battery, grid, battery charge %) that points at one inverter's
 * reading only counts that inverter. This adds a combined metric over all of
 * them, named from the reading (inv1_pv_power + inv2_pv_power -> total_pv_power,
 * battery_soc -> average_battery_soc), and points the role at it. The setup
 * wizard's "energy from power" metrics (solar_energy_today, …) are moved onto
 * the same totals. Back to one inverter: the role and those metrics go back to
 * its reading and the total is switched off.
 *
 * Runs when the set of inverters changes (on start and on saving inverters),
 * not on every start, so a role changed by hand afterwards stays as it is.
 *
 * @module inverterTotals
 */
'use strict';
const { getDb, getConfig, setConfig } = require('./database');
const { logger } = require('./logger');
const { profileNames } = require('./inverterNames');

const DONE_KEY = 'inverter_totals';
const NOTE = 'Added for several inverters';
const WIZARD_NOTE = 'Added by the setup wizard';
// Roles worth a total across inverters: [role, fn, unit]. Same list as the wizard's.
const ROLES = [
  ['solar', 'sum', 'W'], ['consumption', 'sum', 'W'], ['battery_charge', 'sum', 'W'], ['battery_discharge', 'sum', 'W'],
  ['grid_import', 'sum', 'W'], ['grid_export', 'sum', 'W'], ['battery_soc', 'mean', '%'],
  ['daily_solar', 'sum', 'kWh'], ['daily_consumption', 'sum', 'kWh']
];
const totalName = (fn, base) => (fn === 'mean' ? 'average_' : 'total_') + base;
const TOTAL_RE = /^(total|average)_(.+)$/;

function readJson(key, fallback) {
  try { const v = JSON.parse(getConfig(key) || 'null'); return v == null ? fallback : v; } catch (_) { return fallback; }
}

/**
 * Work out the changes without saving anything.
 * @param {Array} dongles      dongle_config
 * @param {object} roles       role_metrics
 * @param {Array} defs         combined_metrics
 * @param {object} done        { profile: signature } from the last run
 * @param {(id: string) => Map|null} [namesFor]
 * @returns {{roles: object, defs: Array, done: object, changes: string[]}}
 */
function planTotals(dongles, roles, defs, done, namesFor = profileNames) {
  roles = { ...roles };
  defs = defs.map(d => ({ ...d }));
  done = { ...done };
  const changes = [];
  const groups = new Map();
  for (const d of dongles) {
    if (!d || !d.enabled || !d.profile || !d.mappings || typeof d.mappings !== 'object') continue;
    if (!groups.has(d.profile)) groups.set(d.profile, []);
    groups.get(d.profile).push(d);
  }
  for (const [profile, members] of groups) {
    const signature = members.map(m => m.name).sort().join('|');
    if (done[profile] === signature) continue;
    done[profile] = signature;
    const names = namesFor(profile);
    if (!names) continue;
    // Each member's metric name for a profile reading, and the reading behind a metric name.
    const readingsOf = base => members.map(m => Object.keys(m.mappings).find(k => names.get(String(m.mappings[k])) === base)).filter(Boolean);
    const baseOf = metric => {
      for (const m of members) if (Object.prototype.hasOwnProperty.call(m.mappings, metric)) return names.get(String(m.mappings[metric])) || null;
      const t = TOTAL_RE.exec(metric || '');
      return t && defs.some(d => d.name === metric && (d.note === NOTE || d.note === WIZARD_NOTE)) ? t[2] : null;
    };
    const labelOf = metric => { const m = members.find(x => Object.prototype.hasOwnProperty.call(x.mappings, metric)); return m ? String(m.name).slice(0, 40) : null; };

    // Where each reading should point: the total (2+ inverters) or the one reading.
    const targets = new Map();   // base|fn -> target metric name
    const target = (base, fn, unit) => {
      const key = base + '|' + fn;
      if (targets.has(key)) return targets.get(key);
      const readings = readingsOf(base);
      const name = totalName(fn, base);
      const existing = defs.find(d => d.name === name);
      let to = null;
      if (readings.length >= 2) {
        if (existing && existing.note !== NOTE && existing.note !== WIZARD_NOTE) {
          to = null;   // a combined metric of the user's own already has this name
        } else {
          const labels = {};
          for (const r of readings) { const l = labelOf(r); if (l) labels[r] = l; }
          const def = { name, unit, enabled: true, fn, inputs: readings, labels, note: existing ? existing.note : NOTE };
          if (existing) {
            if (JSON.stringify([existing.inputs, existing.fn, existing.enabled]) !== JSON.stringify([readings, fn, true])) changes.push(`${name} = ${fn} of ${readings.join(', ')}`);
            Object.assign(existing, def);
          } else {
            defs.push({ id: `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ...def });
            changes.push(`${name} = ${fn} of ${readings.join(', ')}`);
          }
          to = name;
        }
      } else if (readings.length === 1) {
        if (existing && (existing.note === NOTE || existing.note === WIZARD_NOTE) && existing.enabled !== false) { existing.enabled = false; changes.push(`${name} switched off`); }
        to = readings[0];
      }
      targets.set(key, to);
      return to;
    };

    for (const [role, fn, unit] of ROLES) {
      const v = typeof roles[role] === 'string' ? roles[role].trim() : '';
      const base = v && baseOf(v);
      if (!base) continue;
      const to = target(base, fn, unit);
      if (to && to !== v) { roles[role] = to; changes.push(`role ${role}: ${v} -> ${to}`); }
    }
    for (const d of defs) {
      if (d.note !== WIZARD_NOTE || d.fn !== 'energy_today' || !Array.isArray(d.inputs) || d.inputs.length !== 1) continue;
      const base = baseOf(d.inputs[0]);
      if (!base) continue;
      const to = target(base, 'sum', d.input_unit === 'kW' ? 'kW' : 'W');
      if (to && to !== d.inputs[0]) { changes.push(`${d.name}: from ${to} instead of ${d.inputs[0]}`); d.inputs = [to]; }
    }
  }
  return { roles, defs, done, changes };
}

function updateTotals() {
  const dongles = readJson('dongle_config', []);
  if (!Array.isArray(dongles) || !dongles.length) return null;
  const before = { roles: readJson('role_metrics', {}), defs: readJson('combined_metrics', []), done: readJson(DONE_KEY, {}) };
  const plan = planTotals(dongles, before.roles || {}, Array.isArray(before.defs) ? before.defs : [], before.done || {});
  if (JSON.stringify(plan.done) === JSON.stringify(before.done)) return null;
  getDb().transaction(() => {
    if (plan.changes.length) {
      setConfig('role_metrics', JSON.stringify(plan.roles));
      setConfig('combined_metrics', JSON.stringify(plan.defs));
      // List each new total with its unit, as saving combined metrics in Settings does.
      const list = readJson('user_metrics', []);
      if (Array.isArray(list)) {
        let added = false;
        for (const d of plan.defs) {
          if (d.note === NOTE && !list.some(m => m && m.name === d.name)) { list.push({ name: d.name, unit: d.unit, createdAt: Date.now(), combined: true }); added = true; }
        }
        if (added) setConfig('user_metrics', JSON.stringify(list));
      }
    }
    setConfig(DONE_KEY, JSON.stringify(plan.done));
  })();
  if (plan.changes.length) logger.info(`Inverter totals updated: ${plan.changes.join('; ')}`);
  return plan.changes;
}

module.exports = { planTotals, updateTotals, NOTE };
