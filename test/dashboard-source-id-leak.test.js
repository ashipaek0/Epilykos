'use strict';
(async () => {
const assert = require('assert');
const contract = await import('../public/js/dashboard-family-contract.mjs');
const fixture = require('./fixtures/dashboard-family-private-metadata.json');
assert.strictEqual(fixture.privateMetadata, 'PRIVATE_METADATA_SENTINEL_132');
assert.deepStrictEqual(fixture.thresholds, [{ value: 1 }, { value: 1 }], 'duplicate thresholds must remain present and ordered');
assert(fixture.values.includes(null), 'fixture must contain null for no-data');
assert.strictEqual(contract.resolveBinding({ metric: 'null-sample' }, { 'null-sample': null }).status, 'no-data');
assert(Object.prototype.hasOwnProperty.call(fixture.metrics, 'arbitrary.metric/name'), 'arbitrary metric must survive fixture');
assert.strictEqual(fixture.metrics['arbitrary.metric/name'], null);
for (const name of contract.familyNames) {
  const serialized = JSON.stringify(contract.defaultConfig(name));
  assert(!serialized.includes('PRIVATE_METADATA_SENTINEL_132'));
  assert(!/(sensor\.[a-z0-9_]+)/i.test(serialized), `${name} leaks entity ID`);
  assert(!/(latitude|longitude|home_address|location_name)/i.test(serialized), `${name} leaks private metadata`);
}
console.log('dashboard-source-id-leak: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
