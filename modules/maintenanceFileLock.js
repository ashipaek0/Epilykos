'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function tryLock(fd) {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 1000, killSignal: 'SIGKILL'
    });
    let message = '';
    child.stderr.on('data', chunk => { message = (message + chunk.toString()).slice(0, 4096); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(message || `flock stopped (${signal || code})`), { code }));
    });
  });
}

// flock locks the open file description shared with fd 3 in the helper. The
// parent's fd retains the lock after the helper exits. Closing it (or process
// death) releases the lock. Never unlink the shared file: another inode would
// let two maintenance owners run at once.
async function acquireFileLock(file, timeoutMs) {
  const started = performance.now();
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR |
    fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o660);
  let held = false;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Maintenance lock must be a regular file');
    for (;;) {
      try {
        await tryLock(fd);
        held = true;
        let released = false;
        return () => { if (!released) { released = true; fs.closeSync(fd); } };
      } catch (error) {
        if (error.code !== 75) throw new Error(`Cannot acquire shared maintenance lock: ${error.message}`);
        const remaining = timeoutMs - (performance.now() - started);
        if (remaining <= 0) throw new Error('Shared maintenance is busy; lock acquisition timed out');
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
      }
    }
  } finally { if (!held) fs.closeSync(fd); }
}

module.exports = { acquireFileLock };
