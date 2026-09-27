import assert from 'node:assert/strict';
import fs from 'node:fs';
const logic = await import(new URL('../public/js/stat-parity.mjs', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/stat-parity.fixture.json', import.meta.url)));
assert.equal(fixture.stats.length, 14);
assert.equal(new Set(fixture.stats.map(s=>s.title)).size, 14);
for (const stat of fixture.stats) {
  assert.deepEqual(stat.binding, {metric:''});
  assert.equal(stat.reducer, 'lastNotNull');
  assert.equal(typeof stat.title, 'string');
  assert.equal(typeof stat.unit, 'string');
  assert.ok(Number.isInteger(stat.precision));
  assert.ok(['background','value'].includes(stat.colorMode));
  assert.ok(Array.isArray(stat.thresholds));
  assert.ok(!Object.keys(stat).some(k=>/source.?id/i.test(k)));
}
assert.equal(fixture.stats.find(s=>s.title==='Battery Cycles').sparkline,'none');
assert.equal(fixture.stats.filter(s=>s.sparkline==='area').length,13);
assert.deepEqual(fixture.gauge.binding,{metric:''});
assert.equal(fixture.gauge.reducer,'lastNotNull');
assert.equal(logic.selectLastNotNull({metric:'x'}, {x:0}).value, 0);
for (const bad of [{}, {x:null}, {x:'wat'}]) assert.equal(logic.selectLastNotNull({metric:'x'}, bad).status, 'no-data');
assert.equal(logic.evaluateThreshold(0, fixture.stats[1].thresholds), 'green');
assert.equal(logic.formatStatValue(12.34, 'V', 1), '12.3 V');
for (const stat of fixture.stats) assert.equal(stat.sparkline, stat.title === 'Battery Cycles' ? 'none' : 'area');
console.log('stat-card-parity.test.js: passed');
