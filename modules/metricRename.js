/**
 * Rename metrics everywhere they are kept, in one transaction: past readings
 * (metrics, metrics_5m), latest values, combined-metric part totals, and the
 * settings that name metrics (roles, combined metrics, the metrics list,
 * notification rules, PVOutput, grid status, savings, metric sanity lists,
 * dashboards and the Controls page).
 *
 * Only values that name a metric are renamed, never object keys: a role can
 * share its name with a metric (role battery_soc, metric battery_soc).
 * Dashboard references that are also history field names (solar,
 * battery_soc, …) are left alone, since a chart may mean the field.
 *
 * @module metricRename
 */
'use strict';
const { getDb, getConfig, setConfig } = require('./database');

const HISTORY_FIELDS = new Set(['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export',
  'battery_soc', 'generator', 'daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge',
  'daily_grid_import', 'daily_grid_export', 'daily_generator']);
// Card and rule properties that hold one metric name.
const METRIC_PROPS = new Set(['metric', 'savings_metric', 'inverter', 'charger', 'grid_status']);

function readJson(key) {
  const raw = getConfig(key);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch (_) { return undefined; }
}

/**
 * Card/rule configs: values under METRIC_PROPS, and the values (not keys) of a
 * `metrics` map. `layout` marks dashboards, where history field names stay.
 */
function renameInLayout(value, rename, layout = true) {
  if (Array.isArray(value)) return value.map(v => renameInLayout(v, rename, layout));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'metrics' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = {};
      for (const [role, name] of Object.entries(v)) out[k][role] = typeof name === 'string' ? rename(name, layout) : renameInLayout(name, rename, layout);
    } else if (METRIC_PROPS.has(k) && typeof v === 'string') {
      out[k] = rename(v, layout);
    } else {
      out[k] = renameInLayout(v, rename, layout);
    }
  }
  return out;
}

/** Each setting that names metrics, and how to rename inside it. */
const SETTINGS = {
  role_metrics: (v, rename) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([role, m]) => [role, typeof m === 'string' ? rename(m) : m])) : v),
  combined_metrics: (v, rename) => (Array.isArray(v) ? v.map(c => (c && Array.isArray(c.inputs) ? { ...c, inputs: c.inputs.map(i => (typeof i === 'string' ? rename(i) : i)) } : c)) : v),
  user_metrics: (v, rename) => {
    if (!Array.isArray(v)) return v;
    const seen = new Set();
    return v.map(u => (u && typeof u.name === 'string' ? { ...u, name: rename(u.name) } : u))
      .filter(u => !u || typeof u.name !== 'string' || (!seen.has(u.name) && seen.add(u.name)));
  },
  pvoutput_config: (v, rename) => (v && v.metric_map && typeof v.metric_map === 'object'
    ? { ...v, metric_map: Object.fromEntries(Object.entries(v.metric_map).map(([f, m]) => [f, typeof m === 'string' ? rename(m) : m])) } : v),
  notification_rules: (v, rename) => renameInLayout(v, rename, false),
  dashboard_layouts: (v, rename) => renameInLayout(v, rename),
  dashboard_config: (v, rename) => renameInLayout(v, rename),
  controls_layout: (v, rename) => renameInLayout(v, rename),
};
const STRING_SETTINGS = ['grid_status_entity', 'savings_solar_metric'];
const LIST_SETTINGS = ['metric_sanity_allow', 'metric_sanity_deny'];

/**
 * @param {Array<[string,string]>} pairs  [old, new]; olds and news distinct
 * @param {{moveData?: Set<string>, inTransaction?: Function}} opts  olds whose readings move
 *   (default: all); inTransaction runs inside the same transaction
 * @returns {{rows: number, settings: string[]}}
 */
function renameMetrics(pairs, opts = {}) {
  const map = new Map(pairs.filter(([o, n]) => o && n && o !== n));
  if (!map.size) return { rows: 0, settings: [] };
  const moveData = opts.moveData || new Set(map.keys());
  const rename = (name, inLayout) => (map.has(name) && !(inLayout && HISTORY_FIELDS.has(name)) ? map.get(name) : name);
  const db = getDb();
  const changed = [];
  let rows = 0;

  db.transaction(() => {
    const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    for (const [from, to] of map) {
      if (!moveData.has(from)) continue;
      for (const [table, col] of [['metrics', 'metric'], ['metrics_5m', 'metric'], ['combined_part_daily', 'part'], ['combined_part_daily', 'total']]) {
        if (!has(table)) continue;
        // A reading already kept under the new name at the same time wins.
        rows += db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`).run(to, from).changes;
        db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(from);
      }
      const oldLatest = db.prepare('SELECT * FROM latest_metrics WHERE metric = ?').get(from);
      const newLatest = db.prepare('SELECT * FROM latest_metrics WHERE metric = ?').get(to);
      if (oldLatest && (!newLatest || (oldLatest.timestamp || 0) > (newLatest.timestamp || 0))) {
        db.prepare('DELETE FROM latest_metrics WHERE metric = ?').run(to);
        db.prepare('UPDATE latest_metrics SET metric = ? WHERE metric = ?').run(to, from);
      } else {
        db.prepare('DELETE FROM latest_metrics WHERE metric = ?').run(from);
      }
    }

    for (const [key, fn] of Object.entries(SETTINGS)) {
      const before = readJson(key);
      if (before === undefined) continue;
      const after = fn(before, rename);
      if (JSON.stringify(after) !== JSON.stringify(before)) { setConfig(key, JSON.stringify(after)); changed.push(key); }
    }
    for (const key of STRING_SETTINGS) {
      const v = getConfig(key);
      if (v && map.has(v.trim())) { setConfig(key, map.get(v.trim())); changed.push(key); }
    }
    for (const key of LIST_SETTINGS) {
      const raw = getConfig(key);
      if (!raw) continue;
      let list;
      try { list = JSON.parse(raw); } catch (_) { list = null; }
      if (!Array.isArray(list)) list = String(raw).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      const after = list.map(n => rename(String(n)));
      if (after.some((n, i) => n !== list[i])) { setConfig(key, JSON.stringify(after)); changed.push(key); }
    }
    if (opts.inTransaction) opts.inTransaction();
  })();
  return { rows, settings: changed };
}

module.exports = { renameMetrics, renameInLayout, HISTORY_FIELDS };
