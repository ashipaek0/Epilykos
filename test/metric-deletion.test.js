'use strict';
const checks = require('./_checks');
// Settings > Metrics: select several metrics and delete them in one go.
// Same rules as deleting one: roles pointing at a deleted metric are cleared,
// the combined metrics that add it up are named, and a combined metric itself
// is refused (it would be worked out again on the next reading).
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epk-metric-deletion-')));
const db = require('../modules/database');
db.initializeDatabase();
const { deleteMetrics, MAX_AT_ONCE } = require('../modules/metricDeletion');

const now = Math.floor(Date.now() / 1000);
const seed = () => {
  ['a_power', 'b_power', 'c_power', 'keep_me'].forEach(m => db.queueMetricValue(m, 1, now));
  db.flushMetrics();
  db.setConfig('role_metrics', JSON.stringify({ solar_power: 'a_power', load_power: 'keep_me', battery_power: 'c_power' }));
  db.setConfig('combined_metrics', JSON.stringify([{ name: 'total_power', fn: 'sum', inputs: ['a_power', 'b_power'], enabled: true }]));
};
const exists = m => !!db.getDb().prepare('SELECT 1 FROM latest_metrics WHERE metric = ?').get(m);

seed();
let r = deleteMetrics(['a_power', 'b_power', 'a_power', ' c_power ']);
assert.deepEqual(r.deleted.sort(), ['a_power', 'b_power', 'c_power'], 'each metric once, names trimmed');
assert.ok(!exists('a_power') && !exists('b_power') && !exists('c_power') && exists('keep_me'), 'only the chosen ones are gone');
assert.deepEqual(r.rolesCleared.sort(), ['battery_power', 'solar_power'], 'the roles they filled are cleared');
assert.equal(JSON.parse(db.getConfig('role_metrics')).load_power, 'keep_me', 'other roles stay');
assert.deepEqual(r.usedBy, { a_power: ['total_power'], b_power: ['total_power'] }, 'the combined metric that used them is named');
console.log('ok - several metrics deleted at once, roles cleared, users named');

seed();
r = deleteMetrics(['total_power', 'keep_me']);
assert.deepEqual(r.deleted, ['keep_me']);
assert.equal(r.blocked.length, 1);
assert.equal(r.blocked[0].name, 'total_power');
assert.match(r.blocked[0].reason, /combined metric/);
console.log('ok - a combined metric is refused, the rest still go');

assert.deepEqual(deleteMetrics(['no_such_metric']).deleted, ['no_such_metric'], 'an unknown name is a no-op, as when deleting one');
assert.throws(() => deleteMetrics(Array.from({ length: MAX_AT_ONCE + 1 }, (_, i) => 'm' + i)), RangeError);
console.log('ok - unknown names are harmless and the batch is bounded');
checks.done();
