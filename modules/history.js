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

async function pollLegacyHistory() {
  const db = getDb();

  const latest = db.prepare('SELECT metric, value FROM latest_metrics').all();
  const values = {};
  // Match metric names by mapping to canonical keys — handles arbitrary naming from any source
  for (const row of latest) {
    const n = (row.metric || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (!n) continue;
    // Instantaneous power
    if (/^(consumption|load)/.test(n) && /(power|watts|consumption)$/.test(n)) values.consumption = row.value;
    else if (n === 'consumption') values.consumption = row.value;
    else if (/(solar|pv)/.test(n) && /(power|watts)$/.test(n)) values.solar = row.value;
    else if (n === 'solar') values.solar = row.value;
    else if (/^battery/.test(n) && /(charge|charging)/.test(n) && /(power|watts)$/.test(n)) values.battery_charge = row.value;
    else if (n === 'battery_charge') values.battery_charge = row.value;
    else if (/^battery/.test(n) && /(discharge|discharging)/.test(n) && /(power|watts)$/.test(n)) values.battery_discharge = row.value;
    else if (n === 'battery_discharge') values.battery_discharge = row.value;
    // Generic "battery power" without direction — positive = charge, negative = discharge
    else if (/^battery/.test(n) && /(power|watts)$/.test(n)) {
      if (row.value > 0) values.battery_charge = row.value;
      else values.battery_discharge = Math.abs(row.value);
    }
    else if (/^grid/.test(n) && /import/.test(n) && /(power|watts)$/.test(n)) values.grid_import = row.value;
    else if (n === 'grid_import') values.grid_import = row.value;
    else if (/^grid/.test(n) && /export/.test(n) && /(power|watts)$/.test(n)) values.grid_export = row.value;
    else if (n === 'grid_export') values.grid_export = row.value;
    // Generic "grid power" without direction — positive = import, negative = export
    else if (/^grid/.test(n) && /(power|watts)$/.test(n)) {
      if (row.value > 0) values.grid_import = row.value;
      else values.grid_export = Math.abs(row.value);
    }
    // SOC
    else if (/battery/.test(n) && /(soc|percentage|percent)/.test(n)) values.battery_soc = row.value;
    else if (n === 'battery_soc') values.battery_soc = row.value;
    // Daily cumulative totals — match gen/daily/today/cumulative/energy keywords
    else if (/(solar|pv)/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_solar = row.value;
    else if (n === 'daily_solar') values.daily_solar = row.value;
    else if (/(consumption|load)/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_consumption = row.value;
    else if (n === 'daily_consumption') values.daily_consumption = row.value;
    else if (/battery/.test(n) && /(charge|charging)/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_battery_charge = row.value;
    else if (n === 'daily_battery_charge') values.daily_battery_charge = row.value;
    else if (/battery/.test(n) && /(discharge|discharging)/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_battery_discharge = row.value;
    else if (n === 'daily_battery_discharge') values.daily_battery_discharge = row.value;
    // Generic "battery energy" without charge/discharge direction → assume charge cumulative
    else if (/battery/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_battery_charge = row.value;
    else if (/grid/.test(n) && /import/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_grid_import = row.value;
    else if (n === 'daily_grid_import') values.daily_grid_import = row.value;
    else if (/grid/.test(n) && /export/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_grid_export = row.value;
    else if (n === 'daily_grid_export') values.daily_grid_export = row.value;
    // Generic "grid energy" without import/export direction → assume import cumulative
    else if (/grid/.test(n) && /(gen|daily|today|cumulative|energy)/.test(n)) values.daily_grid_import = row.value;
  }
  const cols = ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export',
                 'battery_soc','daily_consumption','daily_solar','daily_battery_charge',
                 'daily_battery_discharge','daily_grid_import','daily_grid_export'];
  for (const col of cols) if (!(col in values)) values[col] = 0;

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
