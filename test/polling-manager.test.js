'use strict';
/**
 * test/polling-manager.test.js — Phase 3 Step 1 fixture (plain-node assert,
 * auto-discovered by test/run-all.js). Uses stub pollFns only — never touches
 * server.js or energy.db.
 */
const assert = require('node:assert');
const { PollingManager, POLL_INTERVAL_MS } = require('../services/PollingManager');
const { resetAll } = require('../modules/circuitBreaker');

let passed = 0;
async function ok(name, fn) {
  resetAll();
  await fn();
  passed++;
  console.log('ok - ' + name);
}

function stubRegistry({ failId = null } = {}) {
  const calls = [];
  const sources = ['ha', 'modbus', 'tuya', 'rs232', 'history', 'grid'].map((id) => ({
    id,
    pollFn: async () => {
      calls.push(id);
      if (id === failId) throw new Error('boom-' + id);
      return 'data-' + id;
    },
  }));
  return { sources, calls };
}

(async () => {
  try {
    await ok('cadence is 30s (matches current loop)', async () => {
      assert.strictEqual(POLL_INTERVAL_MS, 30000);
    });

    await ok('metrics-ready per success, data stays null (DB owns data)', async () => {
      const { sources, calls } = stubRegistry();
      const pm = new PollingManager(sources);
      const ready = [];
      pm.on('metrics-ready', (e) => ready.push(e));
      await pm.runCycle();
      assert.strictEqual(ready.length, 6);
      assert.deepStrictEqual(ready.map((e) => e.sourceId),
        ['ha', 'modbus', 'tuya', 'rs232', 'history', 'grid']);
      for (const e of ready) assert.strictEqual(e.data, null);
      assert.deepStrictEqual(calls, ['ha', 'modbus', 'tuya', 'rs232', 'history', 'grid']);
      pm.stop();
    });

    await ok('device-error per failure, other sources still run', async () => {
      const { sources, calls } = stubRegistry({ failId: 'tuya' });
      const pm = new PollingManager(sources);
      const ready = [], errors = [];
      pm.on('metrics-ready', (e) => ready.push(e));
      pm.on('device-error', (e) => errors.push(e));
      await pm.runCycle();
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].sourceId, 'tuya');
      assert.match(errors[0].error.message, /boom-tuya/);
      assert.strictEqual(ready.length, 5);
      assert.deepStrictEqual(calls,
        ['ha', 'modbus', 'tuya', 'rs232', 'history', 'grid']);
      pm.stop();
    });

    await ok('multiple failures each emit, cycle completes', async () => {
      const calls = [];
      const sources = ['ha', 'modbus', 'grid'].map((id) => ({
        id, pollFn: async () => { calls.push(id); throw new Error('fail-' + id); },
      }));
      const pm = new PollingManager(sources);
      const errors = [];
      pm.on('device-error', (e) => errors.push(e));
      await pm.runCycle();
      assert.strictEqual(errors.length, 3);
      assert.deepStrictEqual(calls, ['ha', 'modbus', 'grid']);
      pm.stop();
    });

    await ok('stop() clears interval and listeners; start() is idempotent', async () => {
      const { sources } = stubRegistry();
      const pm = new PollingManager(sources);
      let cycles = 0;
      const orig = pm.runCycle.bind(pm);
      pm.runCycle = async () => { cycles++; await orig(); };
      pm.intervalMs = 20;
      pm.on('metrics-ready', () => {});
      pm.start();
      pm.start(); // idempotent — still one timer
      await new Promise((r) => setTimeout(r, 70));
      assert.ok(cycles >= 1, 'expected at least one cycle, got ' + cycles);
      const before = cycles;
      assert.strictEqual(pm.listenerCount('metrics-ready'), 1);
      pm.stop();
      assert.strictEqual(pm.running, false);
      assert.strictEqual(pm.listenerCount('metrics-ready'), 0);
      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(cycles, before, 'no further cycles after stop()');
    });

    await ok('default registry maps the six real zero-arg source ids', async () => {
      const pm = new PollingManager(); // default registry, no pollFns invoked
      assert.deepStrictEqual(pm.sources.map((s) => s.id),
        ['ha', 'modbus', 'tuya', 'rs232', 'history', 'grid']);
      for (const s of pm.sources) assert.strictEqual(typeof s.pollFn, 'function');
      pm.stop();
    });

    console.log(`\nPASS polling-manager (${passed} checks)`);
  } catch (e) {
    console.error('FAIL polling-manager:', e);
    process.exit(1);
  }
})();
