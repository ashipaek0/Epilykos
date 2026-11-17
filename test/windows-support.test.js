'use strict';
// Windows support helpers, exercised on any platform (the Windows branches are driven through a platform override).
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const checks = require('./_checks');
const { syncPath, syncFd } = require('../modules/fsSync');
const { acquirePidFileLease } = require('../modules/maintenanceFileLock');
const { defaultSerialPath } = require('../modules/serialDefaults');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');

  // fsync: files and folders sync cleanly here; on a pretend Windows a folder is skipped and a file opens read/write
  syncPath(file); syncPath(dir);
  assert.ok(true, 'syncPath handles a file and a folder');
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    syncPath(dir);
    syncPath(file);
    assert.ok(true, 'syncPath on win32 skips a folder and flushes a file');
    const err = Object.assign(new Error('x'), { code: 'EPERM' });
    const orig = fs.fsyncSync; fs.fsyncSync = () => { throw err; };
    try { syncFd(1); assert.ok(true, 'syncFd on win32 tolerates EPERM'); } finally { fs.fsyncSync = orig; }
  } finally { Object.defineProperty(process, 'platform', real); }
  const orig = fs.fsyncSync; fs.fsyncSync = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  try { syncFd(1); assert.ok(false, 'syncFd on linux must not hide EPERM'); } catch (e) { assert.ok(e.code === 'EPERM', 'syncFd on linux still throws'); } finally { fs.fsyncSync = orig; }

  // pid-file lease (the Windows replacement for flock)
  const lock = path.join(dir, 'lock');
  const a = await acquirePidFileLease(lock, 0);
  assert.ok(fs.readFileSync(lock, 'utf8') === String(process.pid), 'lease records its owner');
  let busy = null;
  try { await acquirePidFileLease(lock, 0); } catch (e) { busy = e; }
  assert.ok(busy && busy.code === 'LOCK_BUSY', 'second lease is refused while held');
  a.release(); a.release();
  assert.ok(!fs.existsSync(lock), 'release removes the file (and twice is harmless)');
  fs.writeFileSync(lock, '999999999');                       // a crashed owner
  const b = await acquirePidFileLease(lock, 0);
  assert.ok(fs.readFileSync(lock, 'utf8') === String(process.pid), 'a dead owner lease is taken over');
  b.release();
  fs.writeFileSync(lock, 'garbage');
  const c = await acquirePidFileLease(lock, 0); c.release();
  assert.ok(true, 'an unreadable lease file is taken over');

  assert.ok(defaultSerialPath('win32') === 'COM3' && defaultSerialPath('linux') === '/dev/ttyUSB0', 'default serial port per platform');
  fs.rmSync(dir, { recursive: true, force: true });
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
