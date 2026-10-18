'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');

// Check in a separate process: quick_check can scan gigabytes in native code.
// Worker termination cannot interrupt that code; a process can be killed on
// cancellation/deadline and reaped before the caller removes its private file.
async function inspectSqliteFile(file, { signal, checkSpace = () => {}, restore = false } = {}) {
  signal?.throwIfAborted();
  const checker = fork(path.join(__dirname, 'sqliteSnapshotCheck.js'), [file, restore ? 'restore' : 'backup'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: ['--max-old-space-size=32']
  });
  const exited = new Promise(resolve => checker.once('close', resolve));
  let abort;
  let deadline, spaceTimer;
  try {
    return await new Promise((resolve, reject) => {
      let result;
      checker.once('message', message => { result = message; });
      checker.once('error', reject);
      checker.once('close', code => {
        if (code === 0 && result?.ok) resolve(result);
        else reject(new Error(result?.error || `Backup validation stopped (exit ${code})`));
      });
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      spaceTimer = setInterval(() => {
        try { checkSpace(); } catch (error) { reject(error); }
      }, 1000);
      deadline = setTimeout(() => reject(new Error('Backup validation timed out')), 30 * 60000);
    });
  } finally {
    clearTimeout(deadline);
    clearInterval(spaceTimer);
    if (abort) signal?.removeEventListener('abort', abort);
    // SIGKILL also interrupts a native SQLite read/busy handler. Always reap
    // the process before releasing maintenance or deleting its input.
    if (checker.exitCode === null && checker.signalCode === null) checker.kill('SIGKILL');
    await exited;
  }
}

module.exports = { inspectSqliteFile };
