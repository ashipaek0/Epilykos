'use strict';
(async () => {
const assert = require('assert');
const { roundTripConfig, mergePersistedBlock, normalizeDashboardConfig, serializeDashboardConfig, deserializeDashboardConfig } = await import('../public/js/dashboard-config-roundtrip.mjs');
const { saveDashboardConfig, fetchDashboardConfig } = await import('../public/js/api.js');
const input = { type:'multi-series-timeseries', config:{ bindings:{ arbitrary:{metric:'unusual.metric'} }, thresholds:[{value:4},{value:4}], series:[{metric:'x', reducer:'avg', formula:'a+b'}], axes:{left:{unit:'W'}}, fallback:{text:'Unavailable'}, noData:{label:'No data'} } };
assert.deepStrictEqual(roundTripConfig(input), input);
const saved = mergePersistedBlock({ ...input, vendorExtension:{ keep:true }, customColor:'violet' }, { gridX:2, gridY:3, gridW:4, gridH:5 });
assert.deepStrictEqual(saved.config, input.config);
const normalized = normalizeDashboardConfig({ dashboards: [{ id: 'main', layout: [saved] }], activeDashboard: 'main' });
let capturedBody;
global.fetch = async (url, options) => {
  if (options?.method === 'POST') { capturedBody = options.body; return { ok: true, status: 200, json: async () => ({}) }; }
  assert.strictEqual(url, '/api/dashboard-config');
  return { ok: true, status: 200, text: async () => capturedBody };
};
await saveDashboardConfig(normalized);
assert.strictEqual(capturedBody, serializeDashboardConfig(normalized));
const reloaded = await fetchDashboardConfig();
assert.deepStrictEqual(reloaded.dashboards[0].layout[0].config, input.config);
assert.deepStrictEqual(reloaded.dashboards[0].layout[0].config.thresholds, [{value:4},{value:4}]);
assert.deepStrictEqual(deserializeDashboardConfig(capturedBody), normalized);
assert.deepStrictEqual(saved.config, input.config);
assert.deepStrictEqual(saved.vendorExtension, { keep:true });
assert.strictEqual(saved.customColor, 'violet');
assert.deepStrictEqual(saved.gridX, 2);
console.log('dashboard-config-roundtrip: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
