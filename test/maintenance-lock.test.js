'use strict';
const checks = require('./_checks');
const assert = require('assert');
const lock = require('../modules/maintenanceLock');

(async () => {
  lock.reset();
  const releaseFirst = await lock.acquireLock('test');
  let secondAcquired = false;
  const second = lock.acquireLock('test').then(release => { secondAcquired = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(secondAcquired, false, 'second acquisition waits');
  releaseFirst();
  const releaseSecond = await second;
  assert.strictEqual(secondAcquired, true);
  releaseSecond();

  const releaseHeld = await lock.acquireLock('timeout');
  await assert.rejects(lock.acquireLock('timeout', { timeoutMs: 20 }), /timed out/i);
  releaseHeld();

  await assert.rejects(lock.withLock('error', async () => { throw new Error('wrapped failure'); }), /wrapped failure/);
  const releaseAfterError = await lock.acquireLock('error', { timeoutMs: 20 });
  releaseAfterError();

  const backupSource = require('fs').readFileSync(require('path').join(__dirname, '../modules/backup.js'), 'utf8');
  assert.match(backupSource, /acquireLock\('maintenance'/);
  console.log('ok - maintenance lock serialization, timeout, release, and backup integration');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
