'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-retention-schema-'));
process.chdir(tmp);
const { initializeDatabase, getDb } = require('../modules/database');
initializeDatabase();
const db = getDb();

const metricsColumns = [
  ['bucket_start', 'INTEGER'], ['metric', 'TEXT'], ['value_avg', 'REAL'],
  ['value_min', 'REAL'], ['value_max', 'REAL'], ['value_count', 'INTEGER']
];
const historyColumns = [
  ['bucket_start', 'INTEGER'],
  ...['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc'].flatMap(name => [
    [`${name}_avg`, 'REAL'], [`${name}_min`, 'REAL'], [`${name}_max`, 'REAL'], [`${name}_count`, 'INTEGER']
  ]),
  ...['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export'].map(name => [`daily_${name}_last`, 'REAL']),
  ...['consumption', 'solar', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export', 'battery_soc'].flatMap(name => [
    [`${name}_last_value`, 'REAL'], [`${name}_last_timestamp`, 'INTEGER']
  ]),
  ['battery_power_sum', 'REAL'], ['battery_power_avg', 'REAL'], ['battery_power_min', 'REAL'],
  ['battery_power_max', 'REAL'], ['battery_power_count', 'INTEGER'],
  ['battery_power_last_value', 'REAL'], ['battery_power_last_timestamp', 'INTEGER']
];
function assertColumns(table, expected) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all();
  assert.deepStrictEqual(actual.map(c => [c.name, c.type]), expected);
  return actual;
}

const metricsInfo = assertColumns('metrics_5m', metricsColumns);
const historyInfo = assertColumns('history_5m', historyColumns);
for (const column of historyInfo.filter(c => c.name.endsWith('_last_value') || c.name.endsWith('_last_timestamp') || c.name.startsWith('battery_power_'))) {
  assert.strictEqual(column.notnull, 0, `${column.name} remains nullable`);
}
const beforeReinitialization = historyInfo.map(c => [c.name, c.type, c.notnull, c.pk, c.dflt_value]);
initializeDatabase();
assert.deepStrictEqual(
  db.prepare('PRAGMA table_info(history_5m)').all().map(c => [c.name, c.type, c.notnull, c.pk, c.dflt_value]),
  beforeReinitialization,
  'reinitialization is idempotent and preserves existing column metadata'
);
assert.deepStrictEqual(metricsInfo.filter(c => c.pk).map(c => [c.pk, c.name]), [[1, 'bucket_start'], [2, 'metric']]);
assert.deepStrictEqual(historyInfo.filter(c => c.pk).map(c => [c.pk, c.name]), [[1, 'bucket_start']]);
assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_metrics_5m_metric_bucket'").get());
assert.throws(() => db.prepare('INSERT INTO metrics_5m (bucket_start, metric, value_count) VALUES (?, ?, ?)').run(0, 'x', -1));
assert.throws(() => db.prepare('INSERT INTO history_5m (bucket_start, consumption_count) VALUES (?, ?)').run(0, -1));
console.log('ok - retention schema');
