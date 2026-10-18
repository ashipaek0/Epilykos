'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { acquireFileLease } = require('./maintenanceFileLock');
const { logger } = require('./logger');
const JOB = /^\.restore-[A-Za-z0-9]{6}$/;
const LOCK = '.owner-lock', OWNER = 'owner.json';
const FILES = new Set([LOCK, OWNER, 'candidate.db', 'candidate.db-wal', 'candidate.db-shm', 'candidate.db-journal', 'scratch']);
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function sync(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function ownerOf(job) {
  const meta = stat(path.join(job, OWNER));
  if (!meta?.isFile() || meta.nlink !== 1 || meta.size > 1024) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(job, OWNER), 'utf8'));
    return owner?.schema === 1 && owner.kind === 'restore-prepare' && typeof owner.leased === 'boolean' ? owner : null;
  } catch (_) { return null; }
}
function protectedByJournal(root, name) {
  const file = path.join(root, '.restore-transaction.json');
  const info = stat(file);
  if (!info) return false;
  if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return true;
  try {
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal?.schema !== 1 || !['pending', 'confirmed'].includes(journal.phase) || !JOB.test(journal.job)
        || ![journal.oldInode, journal.newInode].every(value => typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value))
        || journal.oldInode === journal.newInode) return true;
    return journal.job === name;
  } catch (_) { return true; }
}
function knownContents(job) {
  for (const name of fs.readdirSync(job)) {
    if (!FILES.has(name)) return false; // in particular: never reap original.db
    const info = stat(path.join(job, name));
    if (!info || (name === 'scratch' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) return false;
  }
  return true;
}

// Called by the closed-file transaction while the parent still owns the lease.
// Legacy prepared directories have no ownership metadata to remove.
function removeRestoreStagingMetadata(job) {
  if (!JOB.test(path.basename(job))) throw new Error('Invalid restore staging directory');
  if (!stat(path.join(job, OWNER))) return;
  if (!ownerOf(job)) throw new Error('Unknown restore staging ownership');
  for (const name of ['scratch', LOCK, OWNER]) {
    const file = path.join(job, name), info = stat(file);
    if (!info) continue;
    if (name === LOCK && process.platform !== 'win32') sync(job);
    if (name === 'scratch') {
      if (!info.isDirectory()) throw new Error('Invalid SQLite scratch directory');
      fs.rmSync(file, { recursive: true });
    } else {
      // Keep durable namespace proof until all other metadata is durably gone.
      if (name === OWNER && process.platform !== 'win32') sync(job);
      if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid restore ownership file');
      fs.unlinkSync(file);
    }
  }
}

function removeKnownStaging(job) {
  // Large artifacts disappear durably before their namespace ownership proof.
  for (const name of ['candidate.db', 'candidate.db-wal', 'candidate.db-shm', 'candidate.db-journal']) {
    const file = path.join(job, name); if (stat(file)) fs.unlinkSync(file);
  }
  removeRestoreStagingMetadata(job);
  fs.rmdirSync(job);
  if (process.platform !== 'win32') sync(path.dirname(job));
}

async function createRestoreStaging(root, { requireLease = Boolean(process.env.EPILYKOS_MAINTENANCE_LOCK) } = {}) {
  root = path.resolve(root);
  const directory = fs.mkdtempSync(path.join(root, '.restore-'));
  fs.chmodSync(directory, 0o700);
  let lease, released = false;
  const release = () => { if (!released) { released = true; lease?.release(); } };
  try {
    if (process.platform === 'linux') {
      try { lease = await acquireFileLease(path.join(directory, LOCK), 0, 0o600); }
      catch (error) {
        if (requireLease) throw Object.assign(new Error('Restore staging ownership is unavailable: ' + error.message), { restorePreflight: true, status: 503 });
        logger.warn('Restore staging has no kernel lease; automatic orphan cleanup is disabled for this job: ' + error.message);
      }
    } else if (requireLease) {
      throw Object.assign(new Error('Restore staging requires Linux file leases on this appliance'), { restorePreflight: true, status: 503 });
    }
    if (lease) {
      const held = fs.fstatSync(lease.fd), named = stat(path.join(directory, LOCK));
      if (!named?.isFile() || held.dev !== named.dev || held.ino !== named.ino || held.nlink !== 1) throw new Error('Staging ownership changed during acquisition');
    }
    // Durably publish proof of the private namespace before any candidate write.
    const meta = path.join(directory, OWNER);
    fs.writeFileSync(meta, JSON.stringify({ schema: 1, kind: 'restore-prepare', leased: Boolean(lease) }) + '\n', { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') { sync(meta); sync(directory); sync(root); }
    return {
      directory, leaseFd: lease?.fd,
      release,
      cleanup() {
        try {
          if (protectedByJournal(root, path.basename(directory))) return false;
          if (stat(directory)) {
            if (released) throw new Error('Staging lease was already released; preserving files');
            if (!ownerOf(directory) || !knownContents(directory)) throw new Error('Unknown restore staging contents; preserving files');
            removeKnownStaging(directory);
          }
          return true;
        } finally { release(); }
      }
    };
  } catch (error) {
    lease?.release();
    // No worker has been started, so this invocation owns all files here.
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

async function reapRestoreStaging(root, { signal } = {}) {
  if (process.platform !== 'linux') return []; // uncertain ownership is never age-deleted
  root = path.resolve(root);
  if (!stat(root)) return [];
  const removed = []; let scanned = 0;
  for (const name of fs.readdirSync(root).filter(name => JOB.test(name))) {
    if (++scanned % 64 === 0) await new Promise(resolve => setImmediate(resolve));
    if (signal?.aborted) return removed;
    const job = path.join(root, name); let lease;
    try {
      if (stat(job)?.isDirectory() && !protectedByJournal(root, name)) {
        const names = fs.readdirSync(job);
        // After durable artifact deletion, a crash may leave an empty directory
        // or just its final ownership record; there is no worker output to lose.
        if (names.length === 0 || (names.length === 1 && names[0] === OWNER && ownerOf(job)?.leased)) {
          if (names.length) fs.unlinkSync(path.join(job, OWNER));
          fs.rmdirSync(job); sync(root); removed.push(name); continue;
        }
      }
      const lock = stat(path.join(job, LOCK));
      if (!stat(job)?.isDirectory() || !lock?.isFile() || lock.nlink !== 1 || protectedByJournal(root, name) || !ownerOf(job)?.leased || !knownContents(job)) continue;
      lease = await acquireFileLease(path.join(job, LOCK), 0, 0o600);
      // Recheck after yielding to the flock helper: ownership and journal state
      // may have changed while the helper was acquiring the open description.
      const held = fs.fstatSync(lease.fd), named = stat(path.join(job, LOCK));
      if (signal?.aborted || !named || held.dev !== named.dev || held.ino !== named.ino || protectedByJournal(root, name) || !ownerOf(job)?.leased || !knownContents(job)) continue;
      removeKnownStaging(job); removed.push(name);
    } catch (error) {
      if (!['LOCK_BUSY', 'ENOENT'].includes(error.code)) logger.warn('Restore staging cleanup skipped ' + name + ': ' + error.message);
    } finally { lease?.release(); }
  }
  return removed;
}
function startRestoreStagingCleanup(root) {
  if (process.platform !== 'linux') return async () => {};
  const controller = new AbortController(); let running;
  const tick = () => {
    if (controller.signal.aborted || running) return;
    running = require('./maintenanceLock').withLock('maintenance', () => reapRestoreStaging(root, { signal: controller.signal }))
      .catch(error => logger.warn('Restore staging cleanup deferred: ' + error.message))
      .finally(() => { running = null; });
  };
  tick();
  const timer = setInterval(tick, 60 * 60 * 1000); timer.unref();
  return async () => { controller.abort(); clearInterval(timer); await running; };
}
module.exports = { createRestoreStaging, reapRestoreStaging, removeRestoreStagingMetadata, startRestoreStagingCleanup };
