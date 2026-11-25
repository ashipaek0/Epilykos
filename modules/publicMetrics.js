'use strict';
/**
 * Which readings a visitor (no sign-in) may see.
 *
 * The dashboard is public by design: a visitor sees the dashboards chosen for them (modules/dashboardVisibility.js)
 * and the readings those dashboards show. Settings → Appearance → "Share every reading without signing in" decides
 * whether they may also read the rest (a Home Assistant integration reads every metric without signing in).
 *
 *   on  (the default for an install that already exists): every reading is public, as before.
 *   off (the default for a new install): a visitor gets only the readings the dashboards visible to visitors use,
 *       plus the role metrics (solar, load, battery, grid) that the overview cards are built from.
 *
 * A signed-in session always sees everything. The visitor's copy is made on the server: hiding a reading in the page
 * would leave it one request away. It applies to the metric endpoints, the dashboard state and the live socket.
 *
 * @module publicMetrics
 */

const KEY = 'public_share_all_metrics';
const NAME_MAX = 128;
const CACHE_MS = 2000;

const SOURCE_KEYS = ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices', 'modbus_devices', 'bms_devices', 'external_sources', 'tuya_devices'];

function database() { return require('./database'); }

/** Whether a visitor may read every metric. A missing setting means yes: an install from before the setting keeps its behaviour. */
function shareAll(getConfig = database().getConfig) {
  return getConfig(KEY) !== 'false';
}

function hasEntries(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.length > 0 : !!v && Object.keys(v).length > 0; } catch (_) { return !!raw; }
}

/**
 * Give the setting its first value. An install that has been set up, has a data source or has readings is an existing
 * one and keeps sharing everything; a new one starts with sharing off. Never changes a value that is already there.
 */
function ensureDefault({ getConfig, setConfig, getDb } = database()) {
  const current = getConfig(KEY);
  if (current === 'true' || current === 'false') return current;
  let existing = getConfig('setup_wizard_completed') === 'true' || SOURCE_KEYS.some(k => hasEntries(getConfig(k)));
  if (!existing) {
    try { existing = !!getDb().prepare('SELECT 1 FROM latest_metrics LIMIT 1').get(); } catch (_) { existing = false; }
  }
  const value = existing ? 'true' : 'false';
  setConfig(KEY, value);
  return value;
}

function collectNames(value, out, depth = 0) {
  if (depth > 12 || value == null) return;
  if (typeof value === 'string') { if (value && value.length <= NAME_MAX) out.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectNames(v, out, depth + 1); return; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { if (k.length <= NAME_MAX) out.add(k); collectNames(v, out, depth + 1); }
  }
}

/**
 * The metric names a visitor may read when sharing is off: every string in the dashboards visible to visitors (a card
 * names its metrics there), the role metrics, and the readings behind a combined metric that a visitor can read.
 * @returns {Set<string>}
 */
function computeAllowed({ getConfig, getDashboardConfig, forVisitor } = {}) {
  const db = database();
  getConfig = getConfig || db.getConfig;
  getDashboardConfig = getDashboardConfig || require('./dashboard-config').getDashboardConfig;
  forVisitor = forVisitor || require('./dashboardVisibility').forVisitor;
  const names = new Set();
  try {
    const visible = forVisitor(getDashboardConfig(), { desktop: getConfig('desktop_dashboard'), mobile: getConfig('mobile_dashboard'), extra: getConfig('public_dashboards') });
    for (const d of visible.dashboards || []) collectNames(d.layout, names);
  } catch (_) { /* no dashboards: only the role metrics below */ }
  try {
    const roles = JSON.parse(getConfig('role_metrics') || '{}') || {};
    for (const v of Object.values(roles)) if (typeof v === 'string' && v.trim()) names.add(v.trim());
  } catch (_) { /* no roles */ }
  // A combined metric on show is built from other readings: its parts are shown with it.
  try {
    const defs = JSON.parse(getConfig('combined_metrics') || '[]');
    if (Array.isArray(defs)) {
      for (let changed = true; changed;) {
        changed = false;
        for (const def of defs) {
          if (!def || !names.has(def.name) || !Array.isArray(def.inputs)) continue;
          for (const input of def.inputs) if (typeof input === 'string' && !names.has(input)) { names.add(input); changed = true; }
        }
      }
    }
  } catch (_) { /* no combined metrics */ }
  return names;
}

let cache = null;   // { at, db, names }
/** computeAllowed, kept for a couple of seconds: the state is built every few seconds and every page asks. */
function allowedNames() {
  const db = database().getDb();
  if (cache && cache.db === db && Date.now() - cache.at < CACHE_MS) return cache.names;
  const names = computeAllowed();
  cache = { at: Date.now(), db, names };
  return names;
}
function resetCache() { cache = null; }

/** The readings of a { metricName: … } map that a visitor may see. */
function filterMap(map, allowed) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [name, value] of Object.entries(map)) if (allowed.has(name)) out[name] = value;
  return out;
}

/** The dashboard state as a visitor may see it: the other readings, and the parts behind other combined totals, are left out. */
function filterState(state, allowed) {
  if (!state || typeof state !== 'object') return state;
  const out = { ...state, metrics: filterMap(state.metrics, allowed) };
  if (state.breakdowns && typeof state.breakdowns === 'object') {
    out.breakdowns = { ...state.breakdowns, metrics: filterMap(state.breakdowns.metrics, allowed) };
  }
  return out;
}

/** Whether this request may read every metric: signed in, or sharing is on. */
function seesAll(req) {
  return !!(req && req.session && req.session.authenticated) || shareAll();
}

module.exports = { KEY, shareAll, ensureDefault, computeAllowed, allowedNames, resetCache, filterMap, filterState, seesAll };
