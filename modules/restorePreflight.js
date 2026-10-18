'use strict';
const fs = require('node:fs');
const path = require('node:path');
const host = require('./hostActions');
const { readSpace } = require('./storageStatus');
const { inspectSqliteFile } = require('./sqliteCheck');
const MiB = 1024 * 1024;
const suffixes = ['-wal', '-shm', '-journal'];

function invalid(message) {
  return Object.assign(new Error(message), { restorePreflight: true, status: 400 });
}
function present(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }

// The existing replacement path retains .bak, writes the restored DB and may
// create a migration WAL. Never credit deletion/truncation of the live DB.
function restoreBudget(db, candidateBytes, directory) {
  const appliance = Boolean(process.env.EPILYKOS_MAINTENANCE_LOCK) || host.available();
  return () => {
    const currentBytes = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
    const peak = currentBytes + 2 * candidateBytes + 32 * MiB;
    if (![currentBytes, candidateBytes, peak].every(Number.isSafeInteger) || currentBytes < 0 || candidateBytes <= 0) {
      throw invalid('Cannot determine a safe restore allocation');
    }
    const space = readSpace(directory);
    const floor = appliance && space.available ? space.maintenance_floor_bytes : 0;
    if (!space.available || space.available_bytes - floor < peak) {
      throw Object.assign(new Error('Not enough usable DATA space for restore, rollback and migration allowance'), { restorePreflight: true, status: 507 });
    }
  };
}

async function restorePreflight(file, db, liveFile, { signal, leaseFds = [] } = {}) {
  signal?.throwIfAborted();
  const before = present(file);
  if (!before?.isFile() || before.size < 512 || sameFile(before, present(liveFile))) {
    throw invalid('Restore requires a separate regular SQLite backup file');
  }
  if (suffixes.some(suffix => present(file + suffix))) {
    throw invalid('Restore requires a self-contained backup without WAL, SHM or journal sidecars');
  }
  const checkSpace = restoreBudget(db, before.size, path.dirname(liveFile));
  checkSpace();
  try {
    const result = await inspectSqliteFile(file, { signal, checkSpace, restore: true, leaseFds });
    const after = present(file);
    if (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || result.bytes !== before.size) {
      throw invalid('The backup changed during validation or has an inconsistent file size');
    }
    checkSpace();
    return result;
  } catch (error) {
    if (error.restorePreflight || signal?.aborted) throw error;
    throw invalid('Restore backup validation failed: ' + error.message);
  } finally {
    // A read-only SQLite connection can create empty WAL/SHM files for a
    // standalone WAL-mode backup. Our checker is reaped before this runs.
    const wal = present(file + '-wal'), journal = present(file + '-journal');
    if ((!wal || (wal.isFile() && wal.size === 0)) && (!journal || (journal.isFile() && journal.size === 0))) {
      for (const suffix of suffixes) {
        const sidecar = present(file + suffix);
        if (sidecar?.isFile()) fs.unlinkSync(file + suffix);
      }
    }
  }
}

module.exports = { restorePreflight, restoreBudget };
