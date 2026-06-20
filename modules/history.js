/**
 * History Table Poll — maps metric names to canonical history columns.
 *
 * Every poll cycle, reads all latest_metrics rows and runs them through
 * a compiled set of mappings (regex → target column) to populate the
 * `history` table. Optimized to avoid 40+ individual regex tests per row.
 *
 * @module history
 */
const { logger } = require('./logger');
const { getDb } = require('./database');

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

// ── Compiled Metric Mappings ─────────────────────────────────────────────
//
// Each entry: [regex, targetColumn, subPattern?]
// Tests happen in order; first match wins for a given target column.
// Patterns are precompiled once at module load, not on every poll.

const METRIC_MAPPINGS = [
  // === Instantaneous Power Metrics ===
  // Consumption
  { re: /^(?:consumption|load)(?:_power|_watts)?$/i,        col: 'consumption' },
  // Solar
  { re: /^(?:solar|pv)(?:_power|_watts)?$/i,                col: 'solar' },
  // Battery charge
  { re: /^battery_(?:charge|charging)(?:_power|_watts)?$/i, col: 'battery_charge' },
  // Battery discharge
  { re: /^battery_(?:discharge|discharging)(?:_power|_watts)?$/i, col: 'battery_discharge' },
  // Generic battery power — positive = charge, negative = discharge
  { re: /^battery_(?:power|watts)$/i,                       col: 'battery_power_sign' },  // special handler
  // Grid import
  { re: /^grid_import(?:_power|_watts)?$/i,                 col: 'grid_import' },
  // Grid export
  { re: /^grid_export(?:_power|_watts)?$/i,                 col: 'grid_export' },
  // Generic grid power — positive = import, negative = export
  { re: /^grid_(?:power|watts)$/i,                          col: 'grid_power_sign' },  // special handler

  // === Battery SOC ===
  { re: /^battery_(?:soc|percentage|percent)$/i,            col: 'battery_soc' },

  // === Daily Cumulative Energy Metrics ===
  { re: /^(?:solar|pv).*(?:gen|daily|today|cumulative|energy)/i, col: 'daily_solar' },
  { re: /^daily_solar$/i,                                         col: 'daily_solar' },
  { re: /^(?:consumption|load).*(?:gen|daily|today|cumulative|energy)/i, col: 'daily_consumption' },
  { re: /^daily_consumption$/i,                                    col: 'daily_consumption' },
  { re: /^battery_(?:charge|charging).*(?:gen|daily|today|cumulative|energy)/i, col: 'daily_battery_charge' },
  { re: /^daily_battery_charge$/i,                                  col: 'daily_battery_charge' },
  { re: /^battery_(?:discharge|discharging).*(?:gen|daily|today|cumulative|energy)/i, col: 'daily_battery_discharge' },
  { re: /^daily_battery_discharge$/i,                                col: 'daily_battery_discharge' },
  // Generic battery energy → assume charge cumulative
  { re: /^battery.*(?:gen|daily|today|cumulative|energy)/i,         col: 'daily_battery_charge' },
  { re: /^grid_import.*(?:gen|daily|today|cumulative|energy)/i,     col: 'daily_grid_import' },
  { re: /^daily_grid_import$/i,                                      col: 'daily_grid_import' },
  { re: /^grid_export.*(?:gen|daily|today|cumulative|energy)/i,     col: 'daily_grid_export' },
  { re: /^daily_grid_export$/i,                                      col: 'daily_grid_export' },
  // Generic grid energy → assume import cumulative
  { re: /^grid.*(?:gen|daily|today|cumulative|energy)/i,            col: 'daily_grid_import' },
];

async function pollLegacyHistory() {
  const db = getDb();
  const latest = db.prepare('SELECT metric, value FROM latest_metrics').all();

  // Pre-initialize with zeros
  const values = {
    consumption: 0, solar: 0, battery_charge: 0, battery_discharge: 0,
    grid_import: 0, grid_export: 0, battery_soc: 0,
    daily_consumption: 0, daily_solar: 0, daily_battery_charge: 0,
    daily_battery_discharge: 0, daily_grid_import: 0, daily_grid_export: 0
  };

  for (const row of latest) {
    let matched = false;
    for (const mapping of METRIC_MAPPINGS) {
      if (mapping.re.test(row.metric)) {
        const col = mapping.col;
        if (col === 'battery_power_sign') {
          if (row.value > 0) values.battery_charge = row.value;
          else values.battery_discharge = Math.abs(row.value);
        } else if (col === 'grid_power_sign') {
          if (row.value > 0) values.grid_import = row.value;
          else values.grid_export = Math.abs(row.value);
        } else {
          values[col] = row.value;
        }
        matched = true;
        break; // first match wins
      }
    }
    // If nothing matched, try the generic fallback patterns
    if (!matched) {
      const n = (row.metric || '').toLowerCase().replace(/[\s_-]+/g, '');
      // Consumption power
      if (/^(consumption|load)/.test(n) && /(power|watts)$/.test(n)) values.consumption = row.value;
      // Solar power (already covered above, fallback for edge cases)
      else if (/(solar|pv)/.test(n) && /(power|watts)$/.test(n)) values.solar = row.value;
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
