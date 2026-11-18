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
async function acquireFileLease(file, timeoutMs, mode = 0o660) {
  if (process.platform === 'win32') return acquirePidFileLease(file, timeoutMs, mode);
  const started = performance.now();
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR |
    fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, mode);
  let held = false;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Maintenance lock must be a regular file');
    for (;;) {
      try {
        await tryLock(fd);
        held = true;
        let released = false;
        return { fd, release: () => { if (!released) { released = true; fs.closeSync(fd); } } };
      } catch (error) {
        if (error.code !== 75) throw new Error(`Cannot acquire shared maintenance lock: ${error.message}`);
        const remaining = timeoutMs - (performance.now() - started);
        if (remaining <= 0) throw Object.assign(new Error('Shared maintenance is busy; lock acquisition timed out'), { code: 'LOCK_BUSY' });
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
      }
    }
  } finally { if (!held) fs.closeSync(fd); }
}

/**
 * Windows has no flock. The lease is the file's existence: created exclusively with the owner's process id
 * inside and held open until release, when it is removed. A leftover file whose owner is gone (a crash)
 * is taken over, so a dead process never blocks maintenance forever.
 */
function ownerAlive(file) {
  let pid;
  try { pid = parseInt(fs.readFileSync(file, 'utf8'), 10); } catch (_) { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function acquirePidFileLease(file, timeoutMs, mode = 0o660) {
  const started = performance.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', mode);
      try { fs.writeSync(fd, String(process.pid)); } catch (error) { fs.closeSync(fd); try { fs.unlinkSync(file); } catch (_) {} throw error; }
      let released = false;
      return { fd, release: () => {
        if (released) return;
        released = true;
        fs.closeSync(fd);
        try { fs.unlinkSync(file); } catch (_) {}
      } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error(`Cannot acquire shared maintenance lock: ${error.message}`);
      if (!ownerAlive(file)) { try { fs.unlinkSync(file); } catch (_) {} continue; }
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw Object.assign(new Error('Shared maintenance is busy; lock acquisition timed out'), { code: 'LOCK_BUSY' });
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
  }
}

async function acquireFileLock(file, timeoutMs) { return (await acquireFileLease(file, timeoutMs)).release; }

module.exports = { acquireFileLock, acquireFileLease, acquirePidFileLease };
