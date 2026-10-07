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

module.exports = { getDashboardConfig, saveDashboardConfig, resolveRoleTokens };
