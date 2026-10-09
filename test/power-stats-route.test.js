'use strict';
const checks = require('./_checks');
const assert = require('node:assert/strict');
const dbModule = require('../modules/database');
const originalGetDb = dbModule.getDb;
const fakeDb = { prepare: sql => ({ all: () => sql.includes('history_5m') ? [] : [{ timestamp: Math.floor(Date.now() / 1000), solar: 6 }] }) };
dbModule.getDb = () => fakeDb;
const { router } = require('../routes/metrics');
dbModule.getDb = originalGetDb;
const route = router.stack.find(layer => layer.route?.path === '/history/power-stats').route;
const handler = route.stack[0].handle;
async function request(query) {
  let status = 200, body;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  await handler({ query }, res);
  return { status, body };
}
(async () => {
  for (const query of [{}, { from: '1.2', to: '2', fields: 'pv_power' }, { from: '4', to: '4', fields: 'pv_power' }, { from: '1', to: '604802', fields: 'pv_power' }, { from: '1', to: '2', fields: 'pv_power,grid_power,load_power,battery_charge_power,battery_discharge_power,battery_power,grid_export_power,extra' }]) {
    const response = await request(query);
    assert.equal(response.status, 400);
    assert.equal(typeof response.body.error.code, 'string');
    assert.equal(typeof response.body.error.message, 'string');
  }
  const seven = await request({ from: '1800000000', to: '1800000001', fields: 'pv_power,grid_power,load_power,battery_charge_power,battery_discharge_power,battery_power,grid_export_power' });
  assert.equal(seven.status, 200);
  assert.deepEqual(Object.keys(seven.body.fields), ['pv_power', 'grid_power', 'load_power', 'battery_charge_power', 'battery_discharge_power', 'battery_power', 'grid_export_power']);
  const response = await request({ from: '1800000000', to: '1800000001', fields: 'pv_power,pv_power,unknown' });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.fields), ['pv_power', 'unknown']);
  assert.equal(response.body.fields.unknown.status, 'unsupported');
  const now = Math.floor(Date.now() / 1000);
  const special = await request({ from: String(now), to: String(now + 1), fields: '__proto__,constructor,prototype,toString,pv_power' });
  assert.equal(special.status, 200);
  for (const field of ['__proto__', 'constructor', 'prototype', 'toString']) {
    assert.equal(Object.hasOwn(special.body.fields, field), true);
    assert.equal(special.body.fields[field].status, 'unsupported');
  }
  assert.equal(special.body.fields.pv_power.mean, 6);
  assert.ok(Number.isFinite(special.body.fields.pv_power.mean));
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(special.body.fields))), ['__proto__', 'constructor', 'prototype', 'toString', 'pv_power']);
  console.log('ok - power stats route validation, deduplication, and typed unsupported response');
  checks.done();
})().catch(error => { console.error(error); process.exitCode = 1; });
