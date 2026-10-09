'use strict';
const checks = require('./_checks');
const assert = require('node:assert/strict');
const { readPowerStats } = require('../modules/timeseriesReader');

class FixtureDb {
  constructor(raw = [], rollups = []) { this.raw = raw; this.rollups = rollups; }
  prepare(sql) { return { all: (...args) => sql.includes('history_5m') ? this.rollups.filter(r => r.bucket_start < args[0] && r.bucket_start > args[1]) : this.raw.filter(r => r.timestamp >= args[0] && r.timestamp < args[1]) }; }
}
const from = Math.floor(Date.now() / 1000), to = from + 600;
const db = new FixtureDb([
  { timestamp: from, solar: 0 }, { timestamp: from + 10, solar: -10 },
  { timestamp: from + 20, solar: 30 }, { timestamp: from + 600, solar: 999 }
]);
const result = readPowerStats(db, { from, to, fields: ['pv_power'] });
assert.deepEqual(result.fields.pv_power, {
  status: 'ok', unit: 'W', sum: 20, count: 3, mean: 20 / 3, min: -10, max: 30,
  last: { timestamp: from + 20, value: 30 },
  fidelity: { mean: 'stored_observations', min: 'stored_observations', max: 'stored_observations', last: 'stored_observations', warnings: [{ code: 'legacy_missing_zero_possible', stats: ['mean', 'min', 'max', 'last'] }] }
});
assert.equal(result.range.boundary, '[from,to)');
const rollupFrom = 1700000000;
const rolled = readPowerStats(new FixtureDb([], [
  { bucket_start: rollupFrom, pv_power_avg: 10, pv_power_count: 2, pv_power_min: -5, pv_power_max: 25, pv_power_last_value: 25, pv_power_last_timestamp: rollupFrom + 240 },
  { bucket_start: rollupFrom + 300, pv_power_avg: 20, pv_power_count: 10, pv_power_min: 0, pv_power_max: 40, pv_power_last_value: 40, pv_power_last_timestamp: rollupFrom + 590 }
]), { from: rollupFrom, to: rollupFrom + 600, fields: ['pv_power'] });
assert.equal(rolled.fields.pv_power.sum, 220);
assert.equal(rolled.fields.pv_power.count, 12);
assert.equal(rolled.fields.pv_power.mean, 220 / 12);
assert.equal(rolled.fields.pv_power.min, -5);
assert.equal(rolled.fields.pv_power.max, 40);
assert.deepEqual(rolled.fields.pv_power.last, { timestamp: rollupFrom + 590, value: 40 });
const edge = readPowerStats(new FixtureDb([], [{ bucket_start: rollupFrom + 300, pv_power_avg: 20, pv_power_count: 10, pv_power_min: 0, pv_power_max: 40 }]), { from: rollupFrom + 301, to: rollupFrom + 600, fields: ['pv_power'] });
assert.equal(edge.fields.pv_power.fidelity.mean, 'unavailable');
assert.ok(edge.fields.pv_power.fidelity.warnings.some(w => w.code === 'partial_edge_bucket'));
const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
const knownNewer = readPowerStats(new FixtureDb([{ timestamp: cutoff + 20, solar: 9 }], [
  { bucket_start: cutoff - 300, pv_power_avg: 4, pv_power_count: 2, pv_power_min: 1, pv_power_max: 7 }
]), { from: cutoff - 300, to: cutoff + 100, fields: ['pv_power'] });
assert.deepEqual(knownNewer.fields.pv_power.last, { timestamp: cutoff + 20, value: 9 });
assert.ok(!knownNewer.fields.pv_power.fidelity.warnings.some(w => w.code === 'legacy_rollup_lacks_last'));
const unknown = readPowerStats(new FixtureDb(), { from, to, fields: ['not_real'] });
assert.equal(unknown.fields.not_real.status, 'unsupported');
const specialNames = ['__proto__', 'constructor', 'prototype', 'toString'];
const specialQueries = [];
const specialDb = { prepare(sql) { specialQueries.push(sql); return { all: () => [{ timestamp: from, solar: 12 }] }; } };
const special = readPowerStats(specialDb, { from, to, fields: [...specialNames, 'pv_power'] });
assert.equal(Object.getPrototypeOf(special.fields), null);
for (const field of specialNames) {
  assert.equal(Object.hasOwn(special.fields, field), true);
  assert.equal(special.fields[field].status, 'unsupported');
}
assert.equal(special.fields.pv_power.mean, 12);
assert.ok(specialQueries.every(sql => !specialNames.some(field => sql.includes(field))));
const serializedSpecial = JSON.parse(JSON.stringify(special.fields));
for (const field of specialNames) {
  assert.equal(Object.hasOwn(serializedSpecial, field), true);
  assert.equal(serializedSpecial[field].status, 'unsupported');
}
assert.equal(Object.prototype.polluted, undefined);
const exportStats = readPowerStats(new FixtureDb([
  { timestamp: from, grid_export: -12 }, { timestamp: from + 10, grid_export: 0 },
  { timestamp: from + 20, grid_export: 36 }
]), { from, to, fields: ['grid_export_power'] });
assert.equal(exportStats.fields.grid_export_power.status, 'ok');
assert.equal(exportStats.fields.grid_export_power.sum, 24);
assert.equal(exportStats.fields.grid_export_power.count, 3);
assert.equal(exportStats.fields.grid_export_power.mean, 8);
assert.equal(exportStats.fields.grid_export_power.min, -12);
assert.equal(exportStats.fields.grid_export_power.max, 36);
assert.deepEqual(exportStats.fields.grid_export_power.last, { timestamp: from + 20, value: 36 });
assert.equal(exportStats.fields.grid_export_power.fidelity.warnings[0].code, 'legacy_missing_zero_possible');
const exportRolled = readPowerStats(new FixtureDb([], [{ bucket_start: rollupFrom,
  grid_export_power_avg: -4, grid_export_power_count: 2, grid_export_power_min: -10,
  grid_export_power_max: 2, grid_export_power_last_value: 2, grid_export_power_last_timestamp: rollupFrom + 240
}]), { from: rollupFrom, to: rollupFrom + 300, fields: ['grid_export_power'] });
assert.equal(exportRolled.fields.grid_export_power.sum, -8);
assert.equal(exportRolled.fields.grid_export_power.mean, -4);
assert.equal(exportRolled.fields.grid_export_power.min, -10);
assert.equal(exportRolled.fields.grid_export_power.max, 2);
assert.deepEqual(exportRolled.fields.grid_export_power.last, { timestamp: rollupFrom + 240, value: 2 });
// Aggregate arithmetic must never leak Infinity/NaN into the response.
const overflow = readPowerStats(new FixtureDb([
  { timestamp: from, solar: Number.MAX_VALUE }, { timestamp: from + 1, solar: Number.MAX_VALUE }
]), { from, to, fields: ['pv_power'] }).fields.pv_power;
assert.equal(overflow.sum, null);
assert.equal(overflow.mean, null);
assert.equal(overflow.count, 2);
assert.equal(overflow.status, 'partial');
assert.ok(overflow.fidelity.warnings.some(w => w.code === 'numeric_overflow' && w.stats.includes('mean')));
for (const key of ['sum', 'mean', 'min', 'max']) assert.ok(overflow[key] === null || Number.isFinite(overflow[key]));

// Mixed sources: avoid counting raw points within represented buckets; an unknown
// newer rollup Last makes Last unavailable despite an older known sample.
const mixed = readPowerStats(new FixtureDb([
  { timestamp: cutoff + 20, solar: 7 },  // raw sample newer than the unknown historical Last
  { timestamp: cutoff + 600, solar: 99 } // exclusive upper boundary
], [{ bucket_start: cutoff - 300, pv_power_avg: 5, pv_power_count: 2, pv_power_min: 1, pv_power_max: 9,
  pv_power_last_value: null, pv_power_last_timestamp: null }]),
{ from: cutoff - 300, to: cutoff + 600, fields: ['pv_power'] }).fields.pv_power;
assert.equal(mixed.count, 3);
assert.equal(mixed.sum, 17);
assert.equal(mixed.mean, 17 / 3);
assert.deepEqual(mixed.last, { timestamp: cutoff + 20, value: 7 });
assert.ok(!mixed.fidelity.warnings.some(w => w.code === 'legacy_rollup_lacks_last'));

console.log('ok - power stats reader raw, rollup, mixed-source, boundary, and overflow oracles');
checks.done();
