'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-lock-'));
const file = path.join(dir, 'maintenance.lock');
process.env.EPILYKOS_MAINTENANCE_LOCK = file;
const { acquireLock } = require('../modules/maintenanceLock');
const probe = () => spawnSync('python3', ['-c', `import fcntl,sys
with open(sys.argv[1], 'a+') as f:
 try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
 except BlockingIOError: sys.exit(3)
`, file]).status;
after(() => { delete process.env.EPILYKOS_MAINTENANCE_LOCK; fs.rmSync(dir, { recursive: true, force: true }); });

test('app maintenance excludes an independent host process until release', async () => {
  const release = await acquireLock('maintenance');
  try { assert.equal(probe(), 3); } finally { release(); }
  assert.equal(probe(), 0);
});

test('another process owning maintenance makes the app wait and time out safely', async () => {
  const owner = spawn('python3', ['-u', '-c', `import fcntl,sys,time
with open(sys.argv[1], 'a+') as f:
 fcntl.flock(f, fcntl.LOCK_EX)
 print('ready',flush=True)
 time.sleep(30)
`, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(owner.stdout, 'data');
  let accidental;
  try { await assert.rejects(acquireLock('maintenance', { timeoutMs: 80 }).then(release => { accidental = release; }), /timed out|busy/i); }
  finally { if (accidental) accidental(); owner.kill('SIGKILL'); await once(owner, 'close'); }
  const release = await acquireLock('maintenance', { timeoutMs: 1000 }); release();
  assert.equal(probe(), 0);
});

test('process death releases maintenance without deleting the shared inode', async () => {
  const owner = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('../modules/maintenanceLock'))}).acquireLock('maintenance').then(() => {
      console.log('ready'); setInterval(() => {}, 1000);
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(owner.stdout, 'data');
  const inode = fs.statSync(file).ino;
  try { assert.equal(probe(), 3); }
  finally { owner.kill('SIGKILL'); await once(owner, 'close'); }
  assert.equal(probe(), 0);
  assert.equal(fs.statSync(file).ino, inode);
});

test('symlink lock path is rejected without modifying the target or wedging the queue', async () => {
  const target = path.join(dir, 'private.txt'); fs.writeFileSync(target, 'unchanged', { mode: 0o600 });
  const link = path.join(dir, 'link'); fs.symlinkSync(target, link);
  process.env.EPILYKOS_MAINTENANCE_LOCK = link;
  try {
    await assert.rejects(acquireLock('maintenance', { timeoutMs: 100 }), /symbolic|ELOOP|link/i);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally { process.env.EPILYKOS_MAINTENANCE_LOCK = file; }
  const release = await acquireLock('maintenance', { timeoutMs: 1000 }); release();
});
