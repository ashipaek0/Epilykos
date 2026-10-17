'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');

// Check in a separate process: quick_check can scan gigabytes in native code.
// Worker termination cannot interrupt that code; a process can be killed on
// cancellation/deadline and reaped before the caller removes its private file.
async function checkSnapshot(file, signal) {
  signal?.throwIfAborted();
  const checker = fork(path.join(__dirname, 'sqliteSnapshotCheck.js'), [file], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: ['--max-old-space-size=32']
  });
  const exited = new Promise(resolve => checker.once('close', resolve));
  let abort;
  let deadline;
  try {
    await new Promise((resolve, reject) => {
      let result;
      checker.once('message', message => { result = message; });
      checker.once('error', reject);
      checker.once('close', code => {
        if (code === 0 && result?.ok) resolve();
        else reject(new Error(result?.error || `Backup validation stopped (exit ${code})`));
      });
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      deadline = setTimeout(() => reject(new Error('Backup validation timed out')), 30 * 60000);
    });
  } finally {
    clearTimeout(deadline);
    if (abort) signal?.removeEventListener('abort', abort);
    // SIGKILL also interrupts a native SQLite read/busy handler. Always reap
    // the process before releasing maintenance or deleting its input.
    if (checker.exitCode === null && checker.signalCode === null) checker.kill('SIGKILL');
    await exited;
  }
}

async function createBackupSnapshot(db, destination, { signal } = {}) {
  signal?.throwIfAborted();
  // SQLite's online backup includes committed WAL data and copies incrementally
  // (better-sqlite3 defaults to 100 pages per event-loop turn). Use the normal
  // writer connection: its writes are reflected without restarting the copy.
  await db.backup(destination, { progress: () => { signal?.throwIfAborted(); } });
  signal?.throwIfAborted();
  await checkSnapshot(destination, signal);
  signal?.throwIfAborted();
  return destination;
}

module.exports = { createBackupSnapshot };
