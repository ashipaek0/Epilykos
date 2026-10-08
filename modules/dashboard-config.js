const { logger } = require('./logger');
const { getConfig, setConfig, DEFAULT_DASHBOARD_LAYOUTS_JSON } = require('./database');

// The same starter dashboard a new install gets (database.js).
const DEFAULT_CONFIG = { dashboards: JSON.parse(DEFAULT_DASHBOARD_LAYOUTS_JSON), activeDashboard: 'main' };

/**
 * Fill '{{role:name}}' placeholders with the metric chosen for that role
 * (Settings > Metrics), or '' when none is. Starter dashboards use them so
 * they follow your roles instead of bundling metric names.
 */
function resolveRoleTokens(value, roles) {
  if (typeof value === 'string') {
    const m = /^\{\{role:([a-z_]+)\}\}$/.exec(value);
    return m ? (typeof roles[m[1]] === 'string' ? roles[m[1]].trim() : '') : value;
  }
  if (Array.isArray(value)) return value.map(v => resolveRoleTokens(v, roles));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRoleTokens(v, roles);
    return out;
  }
  return value;
}
function withRoles(config) {
  let roles = {};
  try { roles = JSON.parse(getConfig('role_metrics') || '{}') || {}; } catch (_) { roles = {}; }
  return resolveRoleTokens(config, roles);
}

/**
 * Read dashboard config using new granular keys first, falling back to
 * the legacy dashboard_config blob. Always returns the same shape:
 * { dashboards: [...], activeDashboard: '...' }
 */
function getDashboardConfig() {
  try {
    // Once: switch and selector cards move to the Controls page's own layout.
    const controlsRaw = getConfig('controls_layout');
    if (controlsRaw == null || controlsRaw === '') migrateControlBlocks();
    // Try new granular keys first
    const layoutsStr = getConfig('dashboard_layouts');
    const activeDash = getConfig('dashboard_active');

    if (layoutsStr && layoutsStr.trim() !== '' && layoutsStr !== 'null') {
      const dashboards = JSON.parse(layoutsStr);
      if (Array.isArray(dashboards) && dashboards.length > 0) {
        return withRoles({
          dashboards,
          activeDashboard: activeDash || 'main'
        });
      }
    }

    // Fall back to old dashboard_config blob
    const configStr = getConfig('dashboard_config');
    if (!configStr || configStr.trim() === '' || configStr === 'null') {
      setConfig('dashboard_layouts', JSON.stringify(DEFAULT_CONFIG.dashboards));
      setConfig('dashboard_active', DEFAULT_CONFIG.activeDashboard);
      return withRoles(DEFAULT_CONFIG);
    }
    const parsed = JSON.parse(configStr);
    if (!parsed.dashboards || !Array.isArray(parsed.dashboards) || parsed.dashboards.length === 0) {
      throw new Error('Invalid dashboard config structure');
    }
    return withRoles(parsed);
  } catch (err) {
    logger.error('Error parsing dashboard config, using default:', err.message);
    setConfig('dashboard_layouts', JSON.stringify(DEFAULT_CONFIG.dashboards));
    setConfig('dashboard_active', DEFAULT_CONFIG.activeDashboard);
    return withRoles(DEFAULT_CONFIG);
  }
}

/**
 * Save dashboard config to new granular keys (dashboard_layouts + dashboard_active).
 * Also updates the legacy dashboard_config blob for backward compatibility.
 */
function saveDashboardConfig(config) {
  moveControlBlocksOut(config);
  // Save to new granular keys
  if (config.dashboards) {
    setConfig('dashboard_layouts', JSON.stringify(config.dashboards));
  }
  if (config.activeDashboard) {
    setConfig('dashboard_active', config.activeDashboard);
  }

  // Also save to legacy blob for backward compat
  setConfig('dashboard_config', JSON.stringify(config));
}

// ── Controls page layout ─────────────────────────────────────────────────
// Switch and selector cards live on their own layout, edited as "Controls
// page" in the layout editor and shown only on the signed-in Controls page.
// It is kept apart from the dashboards, whose config is public.

const CONTROL_TYPES = new Set(['switch-block', 'state-select']);
const CONTROLS_MAX_BLOCKS = 200;
const GRID_COLUMNS = 12;

/**
 * Switch and selector cards belong on the Controls page. Once it has its own
 * layout, any that arrive with dashboards (an import, an older open tab) are
 * moved there instead of being saved on a dashboard.
 */
function moveControlBlocksOut(config) {
  if (!config || !Array.isArray(config.dashboards)) return;
  const raw = getConfig('controls_layout');
  if (raw == null || raw === '') return;  // not migrated yet: the first read moves them
  const found = [];
  for (const db of config.dashboards) {
    if (!db || !Array.isArray(db.layout)) continue;
    if (!db.layout.some(b => b && CONTROL_TYPES.has(b.type))) continue;
    db.layout = db.layout.filter(b => { if (b && CONTROL_TYPES.has(b.type)) { found.push(b); return false; } return true; });
  }
  if (!found.length) return;
  let layout;
  try { layout = JSON.parse(raw); } catch (_) { layout = []; }
  if (!Array.isArray(layout)) layout = [];
  const ids = new Set(layout.map(b => b && b.id));
  const fresh = found.filter(b => !ids.has(b.id));
  if (!fresh.length) return;
  const bottom = layout.reduce((m, b) => Math.max(m, (Number(b.gridY) || 0) + (Number(b.gridH) || 0)), 0);
  const added = packBlocks(fresh).map(b => ({ ...b, gridY: b.gridY + bottom }));
  setConfig('controls_layout', JSON.stringify(layout.concat(added).slice(0, CONTROLS_MAX_BLOCKS)));
}

/** Lay blocks out left to right, row by row, keeping their sizes. */
function packBlocks(blocks) {
  let x = 0, y = 0, rowH = 0;
  return blocks.map(b => {
    const w = Math.min(GRID_COLUMNS, Math.max(1, Number(b.gridW) || 3));
    const h = Math.max(1, Number(b.gridH) || 2);
    if (x + w > GRID_COLUMNS) { x = 0; y += rowH; rowH = 0; }
    const out = { ...b, gridX: x, gridY: y, gridW: w, gridH: h };
    x += w; rowH = Math.max(rowH, h);
    return out;
  });
}

/**
 * First read: move the switch and selector cards already on dashboards onto
 * the Controls layout (in dashboard order) and take them off the dashboards.
 */
function migrateControlBlocks() {
  let dashboards = null;
  try { dashboards = JSON.parse(getConfig('dashboard_layouts') || 'null'); } catch (_) { dashboards = null; }
  const moved = [];
  if (Array.isArray(dashboards)) {
    for (const db of dashboards) {
      if (!db || !Array.isArray(db.layout)) continue;
      const keep = [];
      for (const b of db.layout) (b && CONTROL_TYPES.has(b.type) ? moved : keep).push(b);
      db.layout = keep;
    }
    if (moved.length) saveDashboardConfig({ dashboards, activeDashboard: getConfig('dashboard_active') || 'main' });
  }
  const layout = packBlocks(moved);
  setConfig('controls_layout', JSON.stringify(layout));
  if (moved.length) logger.info(`Moved ${moved.length} switch/selector card(s) from dashboards to the Controls page`);
  return layout;
}

function getControlsLayout() {
  const raw = getConfig('controls_layout');
  if (raw == null || raw === '') return migrateControlBlocks();
  try {
    const layout = JSON.parse(raw);
    return Array.isArray(layout) ? layout.filter(b => b && CONTROL_TYPES.has(b.type)) : [];
  } catch (_) { return []; }
}

/** Throws (with a message for the user) when the layout isn't valid. */
function saveControlsLayout(layout) {
  if (!Array.isArray(layout)) throw new Error('The layout must be a list of blocks');
  if (layout.length > CONTROLS_MAX_BLOCKS) throw new Error(`At most ${CONTROLS_MAX_BLOCKS} blocks`);
  for (const b of layout) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Each block must be an object');
    if (!CONTROL_TYPES.has(b.type)) throw new Error('Only switch and selector cards go on the Controls page');
    if (typeof b.id !== 'string' || !b.id || b.id.length > 100) throw new Error('Each block needs an id');
  }
  setConfig('controls_layout', JSON.stringify(layout));
}

module.exports = { getDashboardConfig, saveDashboardConfig, resolveRoleTokens, getControlsLayout, saveControlsLayout, CONTROL_TYPES };
