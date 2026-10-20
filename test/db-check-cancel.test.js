'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('shutdown interrupts a native SQLite check and releases its shared lease without a false corruption result', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-db-check-cancel-'));
  const cwd = process.cwd(), previousLock = process.env.EPILYKOS_MAINTENANCE_LOCK;
  const file = path.join(root, 'test.db'), lock = path.join(root, 'maintenance.lock');
  process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.EPILYKOS_MAINTENANCE_LOCK = lock;
  const check = require('../modules/dbCheck');
  const { acquireFileLease } = require('../modules/maintenanceFileLock');
  check.setPathsForTests(file, path.join(root, '.running'), path.join(root, 'result.json'));
  const blocker = new Database(file); blocker.exec('CREATE TABLE data(value); INSERT INTO data VALUES(1)');
  let transaction = false, running;
  function openTargetFds() {
    const children = fs.readdirSync('/proc').filter(pid => {
      if (!/^\d+$/.test(pid)) return false;
      try { return /^PPid:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] === String(process.pid); } catch (_) { return false; }
    });
    let count = 0;
    for (const pid of [String(process.pid), ...children]) {
      let fds; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (_) { continue; }
      for (const fd of fds) { try { if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === file) count++; } catch (_) {} }
    }
    return count;
  }
  try {
    assert.equal((await check.run('baseline')).ok, true);
    const previous = check.last();
    blocker.exec('BEGIN EXCLUSIVE'); transaction = true;
    const before = openTargetFds(); running = check.run('blocked native check');
    const deadline = Date.now() + 5000;
    while (openTargetFds() <= before && Date.now() < deadline) await pause(10);
    assert.ok(openTargetFds() > before, 'checker opened the locked database, rather than cancellation before native work');
    await assert.rejects(acquireFileLease(lock, 0), error => error.code === 'LOCK_BUSY');
    let timer;
    const stopped = check.stop();
    try {
      const bounded = await Promise.race([stopped.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
      assert.equal(bounded, true, 'stop must interrupt the native busy handler within one second');
    } finally { clearTimeout(timer); }
    assert.deepEqual(await running, { cancelled: true });
    assert.deepEqual(check.last(), previous, 'cancellation must preserve the last actual check result');
    const lease = await acquireFileLease(lock, 0); lease.release();
    assert.equal(openTargetFds(), before, 'checker is reaped before maintenance is released');
  } finally {
    if (transaction) blocker.exec('ROLLBACK');
    await check.stop(); if (running) await running;
    blocker.close(); process.chdir(cwd);
    if (previousLock === undefined) delete process.env.EPILYKOS_MAINTENANCE_LOCK;
    else process.env.EPILYKOS_MAINTENANCE_LOCK = previousLock;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
