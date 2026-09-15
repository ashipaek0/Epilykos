'use strict';
const assert = require('node:assert');
const { getBreaker, resetAll, FAILURE_THRESHOLD, RESET_TIMEOUT_MS } = require('../modules/circuitBreaker');

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log('ok - ' + name);
}

const realNow = Date.now;
let nowVal = realNow();
function stubNow(v) { nowVal = v; Date.now = () => nowVal; }
function restoreNow() { Date.now = realNow; }

(async () => {
  try {
    resetAll();
    assert.strictEqual(FAILURE_THRESHOLD, 5);
    assert.strictEqual(RESET_TIMEOUT_MS, 60000);

    // 1. closed passthrough + returns fn value (async execute)
    await ok('closed passthrough returns value', async () => {
      resetAll();
      const b = getBreaker('a');
      const v = await b.execute(() => 42);
      assert.strictEqual(v, 42);
      assert.strictEqual(b.getState(), 'CLOSED');
      assert.strictEqual(b.getFailures(), 0);
    });

    // 2. 5 sync-throw fails -> open
    await ok('5 consecutive failures opens circuit', async () => {
      resetAll();
      const b = getBreaker('b');
      for (let i = 0; i < 5; i++) {
        await assert.rejects(() => b.execute(() => { throw new Error('x' + i); }), /x/);
      }
      assert.strictEqual(b.getState(), 'OPEN');
      assert.strictEqual(b.getFailures(), 5);
    });

    // 2b. async REJECTIONS count as failures (poll fns are async)
    await ok('async rejections trip the breaker', async () => {
      resetAll();
      const b = getBreaker('b2');
      for (let i = 0; i < 5; i++) {
        await assert.rejects(() => b.execute(async () => { throw new Error('async-x'); }), /async-x/);
      }
      assert.strictEqual(b.getState(), 'OPEN');
      assert.strictEqual(b.getFailures(), 5);
    });

    // 3. open fast-fail (fn not called, ~0ms)
    await ok('open fast-fails without calling fn', async () => {
      resetAll();
      const b = getBreaker('c');
      for (let i = 0; i < 5; i++) {
        try { await b.execute(() => { throw new Error('boom'); }); } catch {}
      }
      let called = false;
      const t0 = Date.now();
      await assert.rejects(() => b.execute(() => { called = true; return 1; }), /circuit-open:c/);
      const dt = Date.now() - t0;
      assert.strictEqual(called, false);
      assert.ok(dt < 50, 'fast-fail took ' + dt + 'ms');
    });

    // 4. probe after timeout via Date.now stub
    await ok('half-open probe success closes circuit', async () => {
      resetAll();
      stubNow(1000000);
      try {
        const b = getBreaker('d');
        for (let i = 0; i < 5; i++) {
          try { await b.execute(() => { throw new Error('f'); }); } catch {}
        }
        assert.strictEqual(b.getState(), 'OPEN');
        stubNow(1000000 + RESET_TIMEOUT_MS + 1);
        const v = await b.execute(() => 'recovered');
        assert.strictEqual(v, 'recovered');
        assert.strictEqual(b.getState(), 'CLOSED');
        assert.strictEqual(b.getFailures(), 0);
      } finally { restoreNow(); }
    });

    await ok('half-open probe failure re-opens with new window', async () => {
      resetAll();
      stubNow(2000000);
      try {
        const b = getBreaker('e');
        for (let i = 0; i < 5; i++) {
          try { await b.execute(() => { throw new Error('f'); }); } catch {}
        }
        const openedAt = 2000000;
        stubNow(openedAt + RESET_TIMEOUT_MS + 1);
        await assert.rejects(() => b.execute(() => { throw new Error('still-bad'); }), /still-bad/);
        assert.strictEqual(b.getState(), 'OPEN');
        // new window: fast-fail immediately after
        let called = false;
        await assert.rejects(() => b.execute(() => { called = true; }), /circuit-open:e/);
        assert.strictEqual(called, false);
      } finally { restoreNow(); }
    });

    // 5. resetAll clears
    await ok('resetAll clears registry', async () => {
      resetAll();
      const b1 = getBreaker('z');
      try { await b1.execute(() => { throw new Error('f'); }); } catch {}
      assert.strictEqual(b1.getFailures(), 1);
      resetAll();
      const b2 = getBreaker('z');
      assert.notStrictEqual(b2, b1);
      assert.strictEqual(b2.getFailures(), 0);
      assert.strictEqual(b2.getState(), 'CLOSED');
    });

    console.log(`\nPASS: ${passed} checks passed`);
  } catch (e) {
    restoreNow();
    console.error('FAIL: ' + e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
