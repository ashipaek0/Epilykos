'use strict';
const checks = require('./_checks');
// One slow source no longer holds up the others (services/PollingManager.js):
// device sources run side by side in lanes, each with a deadline, and a read
// that overran is never started a second time while it is still going.
const assert = require('node:assert/strict');
const { PollingManager, SOURCE_DEADLINE_MS, defaultRegistry } = require('../services/PollingManager');
const { resetAll } = require('../modules/circuitBreaker');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // The deadline timer does not keep Node running (it must not hold a server open), so this does.
  const alive = setInterval(() => {}, 1000);
  assert.equal(SOURCE_DEADLINE_MS, 20000);
  const lanes = Object.fromEntries(defaultRegistry().map(s => [s.id, s.lane]));
  assert.equal(lanes.modbus, 'serial'); assert.equal(lanes.rs232, 'serial', 'the two that can use a serial port take turns');
  assert.notEqual(lanes.ha, lanes.tuya); assert.notEqual(lanes.ha, lanes.modbus);
  for (const id of ['battery', 'combined', 'history', 'grid', 'generator']) assert.equal(lanes[id], undefined, id + ' works from the database: in order, after the devices');

  // Lanes side by side; one lane in order; the rest afterwards, in order.
  resetAll();
  const log = [];
  const src = (id, lane, ms) => ({ id, lane, pollFn: async () => { log.push('start ' + id); await sleep(ms); log.push('end ' + id); } });
  let pm = new PollingManager([src('ha', 'ha', 60), src('modbus', 'serial', 20), src('tuya', 'tuya', 10), src('rs232', 'serial', 20), src('combined', undefined, 5), src('history', undefined, 5)]);
  const ready = [];
  pm.on('metrics-ready', e => ready.push(e.sourceId));
  const t0 = Date.now();
  await pm.runCycle();
  const took = Date.now() - t0;
  assert.ok(log.indexOf('start tuya') < log.indexOf('end ha'), 'Tuya did not wait for Home Assistant');
  assert.ok(log.indexOf('start modbus') < log.indexOf('end ha'), 'nor did Modbus');
  assert.ok(log.indexOf('end modbus') < log.indexOf('start rs232'), 'the serial lane takes turns');
  assert.ok(log.indexOf('end ha') < log.indexOf('start combined'), 'derived values wait for every device');
  assert.ok(log.indexOf('end combined') < log.indexOf('start history'));
  assert.ok(took < 60 + 20 + 20 + 10 + 10 + 40, `side by side, not one after another (${took} ms)`);
  assert.deepEqual(ready, ['ha', 'modbus', 'tuya', 'rs232', 'combined', 'history'], 'reported in the usual order');
  pm.stop();
  console.log('ok - device sources run side by side; a serial lane and the derived steps keep their order');

  // A source past its deadline: the cycle goes on without it.
  resetAll();
  let haCalls = 0, release;
  const stuck = new Promise(r => { release = r; });
  pm = new PollingManager([
    { id: 'ha', lane: 'ha', pollFn: async () => { haCalls++; await stuck; } },
    { id: 'modbus', lane: 'serial', pollFn: async () => 'ok' },
    { id: 'combined', pollFn: async () => 'ok' },
  ]);
  pm.deadlineMs = 40;
  let errors = [], ok = [];
  pm.on('device-error', e => errors.push(e)); pm.on('metrics-ready', e => ok.push(e.sourceId));
  const t1 = Date.now();
  await pm.runCycle();
  assert.ok(Date.now() - t1 < 400, 'the cycle did not wait for the stuck source');
  assert.deepEqual(ok, ['modbus', 'combined']);
  assert.equal(errors.length, 1); assert.equal(errors[0].sourceId, 'ha');
  assert.match(errors[0].error.message, /did not answer within/);

  // While that read is still going, the source is not started again.
  errors = []; ok = [];
  await pm.runCycle();
  assert.equal(haCalls, 1, 'never polled twice at once');
  assert.match(errors[0].error.message, /still busy/);
  assert.deepEqual(ok, ['modbus', 'combined']);

  // When it ends, the source is polled again.
  release(); await sleep(5);
  errors = []; ok = [];
  pm.sources[0].pollFn = async () => { haCalls++; return 'ok'; };
  await pm.runCycle();
  assert.equal(haCalls, 2);
  assert.deepEqual(ok, ['ha', 'modbus', 'combined']);
  assert.equal(errors.length, 0);
  pm.stop();
  console.log('ok - a source past its deadline is left behind, not started twice, and picked up again when it ends');

  // A source without a lane has no deadline (it works from the database).
  resetAll();
  pm = new PollingManager([{ id: 'history', pollFn: async () => { await sleep(80); return 'ok'; } }]);
  pm.deadlineMs = 10;
  ok = []; pm.on('metrics-ready', e => ok.push(e.sourceId));
  await pm.runCycle();
  assert.deepEqual(ok, ['history']);
  pm.stop();
  clearInterval(alive);
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
