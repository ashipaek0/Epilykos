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
  const metricMap = { /* same as before */ };

  const latest = db.prepare('SELECT metric, value FROM latest_metrics').all();
  const values = {};
  for (const row of latest) {
    if (metricMap[row.metric]) values[metricMap[row.metric]] = row.value;
  }
  const cols = Object.values(metricMap);
  for (const col of cols) if (!(col in values)) values[col] = 0;

  const now = Math.floor(Date.now() / 1000);
  getHistoryInsert().run(now, values.consumption, values.solar, values.battery_charge, values.battery_discharge,
                    values.grid_import, values.grid_export, values.battery_soc,
                    values.daily_consumption, values.daily_solar, values.daily_battery_charge,
                    values.daily_battery_discharge, values.daily_grid_import, values.daily_grid_export);
}

module.exports = { pollLegacyHistory };
