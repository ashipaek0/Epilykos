'use strict';
const checks = require('./_checks');
const assert = require('assert');
const Database = require('better-sqlite3');
const { migratePowerStatsSchema } = require('../modules/database');
const { runHistoryBatch } = require('../modules/retentionJob');

const db = new Database(':memory:');
db.exec(`CREATE TABLE history_5m (bucket_start INTEGER PRIMARY KEY,
 consumption_avg REAL, consumption_min REAL, consumption_max REAL, consumption_count INTEGER NOT NULL,
 solar_avg REAL, solar_min REAL, solar_max REAL, solar_count INTEGER NOT NULL,
 battery_charge_avg REAL, battery_charge_min REAL, battery_charge_max REAL, battery_charge_count INTEGER NOT NULL,
 battery_discharge_avg REAL, battery_discharge_min REAL, battery_discharge_max REAL, battery_discharge_count INTEGER NOT NULL,
 grid_import_avg REAL, grid_import_min REAL, grid_import_max REAL, grid_import_count INTEGER NOT NULL,
 grid_export_avg REAL, grid_export_min REAL, grid_export_max REAL, grid_export_count INTEGER NOT NULL,
 battery_soc_avg REAL, battery_soc_min REAL, battery_soc_max REAL, battery_soc_count INTEGER NOT NULL,
 daily_consumption_last REAL, daily_solar_last REAL, daily_battery_charge_last REAL,
 daily_battery_discharge_last REAL, daily_grid_import_last REAL, daily_grid_export_last REAL);
 CREATE TABLE history (timestamp INTEGER PRIMARY KEY, consumption REAL, solar REAL, battery_charge REAL,
 battery_discharge REAL, grid_import REAL, grid_export REAL, battery_soc REAL,
 daily_consumption REAL, daily_solar REAL, daily_battery_charge REAL, daily_battery_discharge REAL,
 daily_grid_import REAL, daily_grid_export REAL);`);

migratePowerStatsSchema(db);
migratePowerStatsSchema(db);
const cols = new Set(db.prepare('PRAGMA table_info(history_5m)').all().map(c => c.name));
for (const field of ['consumption','solar','battery_charge','battery_discharge','grid_import','grid_export','battery_soc']) {
  assert(cols.has(`${field}_last_value`));
  assert(cols.has(`${field}_last_timestamp`));
}
for (const col of ['battery_power_sum','battery_power_avg','battery_power_min','battery_power_max','battery_power_count','battery_power_last_value','battery_power_last_timestamp']) assert(cols.has(col));
assert.strictEqual(db.prepare('SELECT battery_power_count FROM history_5m').get(), undefined, 'migration does not fabricate old rows');

db.prepare('INSERT INTO history(timestamp, battery_charge, battery_discharge, solar) VALUES (?, ?, ?, ?)').run(1_999_998_000, 10, 3, 100);
db.prepare('INSERT INTO history(timestamp, battery_charge, battery_discharge, solar) VALUES (?, ?, ?, ?)').run(1_999_998_010, 1, 8, 200);
db.prepare('INSERT INTO history(timestamp, battery_charge, battery_discharge, solar) VALUES (?, ?, ?, ?)').run(1_999_998_020, 0, null, 300);
const now = 2_000_000_200;
const cutoff = now - 30 * 24 * 60 * 60;
// Test using historical timestamps by moving retention cutoff via cutoff argument.
runHistoryBatch(db, 2_000_000_100);
const row = db.prepare('SELECT * FROM history_5m').get();
assert.strictEqual(row.battery_power_sum, 0); // paired net: +7, -7; unpaired charge is excluded
assert.strictEqual(row.battery_power_count, 2);
assert.strictEqual(row.battery_power_avg, 0);
assert.strictEqual(row.battery_power_min, -7);
assert.strictEqual(row.battery_power_max, 7);
assert.deepStrictEqual([row.battery_power_last_value, row.battery_power_last_timestamp], [-7, 1_999_998_010]);
assert.deepStrictEqual([row.solar_last_value, row.solar_last_timestamp], [300, 1_999_998_020]);
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM history').get().n, 0, 'rolled raw observations are pruned');
console.log('ok - power stats migration and paired battery retention rollups');
db.close();
checks.done();
