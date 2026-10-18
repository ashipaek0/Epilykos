'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');

// Check in a separate process: quick_check can scan gigabytes in native code.
// Worker termination cannot interrupt that code; a process can be killed on
// cancellation/deadline and reaped before the caller removes its private file.
async function runSqliteProcess(script, args, { signal, checkSpace = () => {} } = {}) {
  signal?.throwIfAborted();
  const checker = fork(path.join(__dirname, script), args, {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: ['--max-old-space-size=32'],
    env: { ...process.env, LOG_TO_FILE: 'false', SQLITE_SYNCHRONOUS: 'FULL' }
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
        else reject(Object.assign(new Error(result?.error || `SQLite operation stopped (exit ${code})`), { code: result?.code }));
      });
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      spaceTimer = setInterval(() => {
        try { checkSpace(); } catch (error) { reject(error); }
      }, 1000);
      deadline = setTimeout(() => reject(new Error('SQLite operation timed out')), 30 * 60000);
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

function inspectSqliteFile(file, { restore = false, ...options } = {}) {
  return runSqliteProcess('sqliteSnapshotCheck.js', [file, restore ? 'restore' : 'backup'], options);
}

module.exports = { inspectSqliteFile, runSqliteProcess };
