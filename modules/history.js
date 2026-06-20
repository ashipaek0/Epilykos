/**
 * History Table Poll — maps metric names to canonical history columns.
 *
 * Every poll cycle, reads all latest_metrics rows and uses a configurable
 * role-to-metric-name mapping (stored in config as `role_metrics`) to
 * populate the `history` table. No regex guessing — exact name lookup only.
 *
 * If `role_metrics` is not configured, it auto-populates from the dashboard
 * config's first flow-card/flow-card-2 block, or falls back to empty (zeros).
 *
 * @module history
 */
const { logger } = require('./logger');
const { getDb, getConfig, setConfig } = require('./database');

let historyInsertStmt = null;

function getHistoryInsert() {
  if (!historyInsertStmt) {
    const db = getDb();
    historyInsertStmt = db.prepare(`
      INSERT OR REPLACE INTO history
      (timestamp, consumption, solar, battery_charge, battery_discharge, grid_import, grid_export, battery_soc,
       daily_consumption, daily_solar, daily_battery_charge, daily_battery_discharge, daily_grid_import, daily_grid_export)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  return historyInsertStmt;
}

// ── Default role → metric name mapping ──────────────────────────────────
// These are role keys used by the history table. Their values are the actual
// metric names from latest_metrics (configurable per user).
const DEFAULT_ROLES = [
  // Instantaneous power
  'solar', 'consumption', 'battery_charge', 'battery_discharge',
  'grid_import', 'grid_export',
  // Battery SOC
  'battery_soc',
  // Daily energy totals
  'daily_solar', 'daily_consumption', 'daily_battery_charge',
  'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export',
];

const ROLE_TO_COL = {
  solar: 'solar', consumption: 'consumption',
  battery_charge: 'battery_charge', battery_discharge: 'battery_discharge',
  grid_import: 'grid_import', grid_export: 'grid_export',
  battery_soc: 'battery_soc',
  daily_solar: 'daily_solar', daily_consumption: 'daily_consumption',
  daily_battery_charge: 'daily_battery_charge', daily_battery_discharge: 'daily_battery_discharge',
  daily_grid_import: 'daily_grid_import', daily_grid_export: 'daily_grid_export',
};

const ZERO_VALUES = {
  consumption: 0, solar: 0, battery_charge: 0, battery_discharge: 0,
  grid_import: 0, grid_export: 0, battery_soc: 0,
  daily_consumption: 0, daily_solar: 0, daily_battery_charge: 0,
  daily_battery_discharge: 0, daily_grid_import: 0, daily_grid_export: 0,
};

/**
 * Auto-populate `role_metrics` config from all dashboard blocks.
 * Scans every block across all dashboards to build the most complete
 * role → metric name mapping possible.
 */
function autoPopulateRoleMetrics() {
  try {
    const dcRaw = getConfig('dashboard_config');
    if (!dcRaw) return;
    const dc = JSON.parse(dcRaw);
    const mapping = {};
    // Map flow-card/flow-card-2 role keys to history role keys
    const roleMap = {
      solar: 'solar', consumption: 'consumption',
      battery_power: 'battery_charge', battery_discharge: 'battery_discharge',
      grid: 'grid_import', grid_export: 'grid_export',
      battery_soc: 'battery_soc',
    };
    for (const dash of (dc.dashboards || [])) {
      for (const block of (dash.layout || [])) {
        const metrics = block.config?.metrics;
        if (!metrics) continue;
        for (const [roleKey, metricName] of Object.entries(metrics)) {
          const historyRole = roleMap[roleKey];
          if (historyRole && metricName && typeof metricName === 'string' && metricName.trim()) {
            mapping[historyRole] = metricName.trim();
          }
        }
        // Also capture actual_energy from forecast blocks → daily_solar
        if (metrics.actual_energy && typeof metrics.actual_energy === 'string' && metrics.actual_energy.trim()) {
          if (!mapping.daily_solar) mapping.daily_solar = metrics.actual_energy.trim();
        }
      }
    }
    if (Object.keys(mapping).length > 0) {
      setConfig('role_metrics', JSON.stringify(mapping));
      logger.info('[history] Auto-populated role_metrics:', mapping);
    }
  } catch (e) {
    logger.warn('[history] Could not auto-populate role_metrics:', e.message);
  }
}

/**
 * Get the role → metric name mapping from config, auto-populating if empty.
 */
function getRoleMetrics() {
  const raw = getConfig('role_metrics');
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {} 
  }
  // Auto-populate on first call
  autoPopulateRoleMetrics();
  const retry = getConfig('role_metrics');
  if (retry) {
    try { return JSON.parse(retry); } catch (e) {}
  }
  return {};
}

/**
 * Build a reverse lookup: metric name → role.
 */
function buildMetricToRole(roleMetrics) {
  const map = {};
  for (const [role, metricName] of Object.entries(roleMetrics)) {
    if (metricName && typeof metricName === 'string') {
      map[metricName.trim()] = role;
    }
  }
  return map;
}

async function pollLegacyHistory() {
  const db = getDb();
  const latest = db.prepare('SELECT metric, value FROM latest_metrics').all();
  const roleMetrics = getRoleMetrics();
  const metricToRole = buildMetricToRole(roleMetrics);

  // Start all values at 0
  const values = { ...ZERO_VALUES };

  // Direct name lookup — no regex, no guessing
  for (const row of latest) {
    const role = metricToRole[row.metric];
    if (role && ROLE_TO_COL[role]) {
      const col = ROLE_TO_COL[role];
      // Handle sign-based battery/grid power with a single metric
      if (role === 'battery_charge' && roleMetrics.battery_discharge && row.metric === roleMetrics.battery_discharge) {
        // This row is for discharge, not charge
        continue;
      }
    }
    if (role) {
      const col = ROLE_TO_COL[role];
      if (col) {
        values[col] = row.value;
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  getHistoryInsert().run(
    now,
    values.consumption, values.solar, values.battery_charge, values.battery_discharge,
    values.grid_import, values.grid_export, values.battery_soc,
    values.daily_consumption, values.daily_solar, values.daily_battery_charge,
    values.daily_battery_discharge, values.daily_grid_import, values.daily_grid_export
  );
}

module.exports = { pollLegacyHistory };
