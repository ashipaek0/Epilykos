'use strict';
// The EpilykosOS update guard (guard-v1) under the shared maintenance lock:
// active/reconciling block all app maintenance, pending blocks only work
// that changes data compatibility (restore), a named but missing or broken
// guard fails closed, and no guard (Docker, older EpilykosOS) blocks nothing.
// The real file lease is held while the guard is read and released on refusal.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-guard-'));
const lock = path.join(dir, 'maintenance.lock');
const guard = path.join(dir, 'guard.json');
process.env.EPILYKOS_MAINTENANCE_LOCK = lock;
const { acquireLock, reset } = require('../modules/maintenanceLock');
const osUpdateGuard = require('../modules/osUpdateGuard');
const free = () => spawnSync('python3', ['-c', `import fcntl,sys
with open(sys.argv[1], 'a+') as f:
 try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
 except BlockingIOError: sys.exit(3)
`, lock]).status === 0;
const write = (state) => fs.writeFileSync(guard, JSON.stringify({ schema: 1, state, job: state === 'idle' ? null : 'j' }));
after(() => {
  delete process.env.EPILYKOS_MAINTENANCE_LOCK; delete process.env.EPILYKOS_OS_UPDATE_GUARD;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no guard named: nothing is blocked (Docker, older EpilykosOS)', async () => {
  delete process.env.EPILYKOS_OS_UPDATE_GUARD;
  assert.equal(osUpdateGuard.state(), 'idle');
  const release = await acquireLock('maintenance'); release();
});

test('each guard state against restore-like and backup-like maintenance', async () => {
  process.env.EPILYKOS_OS_UPDATE_GUARD = guard;
  const cases = { idle: [true, true], pending: [false, true], active: [false, false], reconciling: [false, false] };
  for (const [state, [restore, backup]] of Object.entries(cases)) {
    write(state);
    for (const [allowPendingOsUpdate, expected] of [[false, restore], [true, backup]]) {
      const attempt = acquireLock('maintenance', { allowPendingOsUpdate });
      if (expected) (await attempt)();
      else await assert.rejects(attempt, err => err.code === 'LOCK_BUSY' && err.osUpdate === state && /EpilykosOS update|interrupted update/.test(err.message));
      assert.ok(free(), `${state}: the file lease is released either way`);
    }
  }
  reset();
});

test('a named guard that is missing, malformed or unknown fails closed', async () => {
  process.env.EPILYKOS_OS_UPDATE_GUARD = guard;
  for (const content of [null, '{', JSON.stringify({ schema: 2, state: 'idle' }), JSON.stringify({ schema: 1, state: 'odd' })]) {
    if (content === null) fs.rmSync(guard, { force: true }); else fs.writeFileSync(guard, content);
    assert.equal(osUpdateGuard.state(), 'reconciling');
    await assert.rejects(acquireLock('maintenance', { allowPendingOsUpdate: true }), { code: 'LOCK_BUSY' });
  }
});

test('other lock labels never read the guard', async () => {
  process.env.EPILYKOS_OS_UPDATE_GUARD = guard;
  write('active');
  const release = await acquireLock('metrics-flush'); release();
});

test('callers: only restore refuses while an update is pending', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'modules', f), 'utf8');
  assert.match(src('backup.js'), /acquireLock\('maintenance', \{ timeoutMs: MAINTENANCE_TIMEOUT_MS, allowPendingOsUpdate: true \}\);\n    controller/, 'backup download');
  assert.match(src('backup.js'), /acquire: \(\) => acquireLock\('maintenance', \{ timeoutMs: 0, allowPendingOsUpdate: true \}\)/, 'snapshots');
  assert.match(src('backup.js'), /const release = maintenanceLease \|\| await acquireLock\('maintenance', \{ timeoutMs: MAINTENANCE_TIMEOUT_MS \}\)/, 'restore refuses');
  assert.doesNotMatch(src('restoreUploads.js'), /allowPendingOsUpdate/, 'restore uploads refuse');
  for (const f of ['dbCheck.js', 'retentionJob.js', 'restoreStaging.js']) assert.match(src(f), /allowPendingOsUpdate: true/, f);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'), /^LABEL io\.epilykos\.os-update-guard="guard-v1"$/m);
});
