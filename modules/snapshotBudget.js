'use strict';
const fs = require('node:fs');
const { readSpace } = require('./storageStatus');
const host = require('./hostActions');
const MiB = 1024 * 1024;

function gzipLimit(bytes) { return bytes + Math.ceil(bytes / 100) + MiB; }

class StorageAdmissionError extends Error {
  constructor(message) { super(message); this.code = 'INSUFFICIENT_STORAGE'; }
}

// Caller holds maintenance through capture/validation. Completed downloads are
// immutable; their allocated bytes are already excluded by statfs.bavail.
function snapshotBudget(db, directory, { compressed = false } = {}) {
  const appliance = Boolean(process.env.EPILYKOS_MAINTENANCE_LOCK) || host.available();
  const pages = db.pragma('page_count', { simple: true });
  const pageSize = db.pragma('page_size', { simple: true });
  const bytes = pages * pageSize;
  if (!Number.isSafeInteger(pages) || pages < 0 || !Number.isSafeInteger(pageSize)
      || pageSize < 512 || pageSize > 65536 || !Number.isSafeInteger(bytes)) {
    throw new StorageAdmissionError('Cannot determine a safe SQLite backup size');
  }
  // Permit bounded writer growth; abort rather than silently exceed the budget.
  const growth = Math.max(16 * MiB, Math.ceil(bytes / 100 / pageSize) * pageSize);
  const maxOutput = bytes + growth;
  // Metadata/journal allowance plus one 100-page native transfer. This
  // budgets our own next copy step; unrelated writers still need rechecks.
  const guard = 16 * MiB + 100 * pageSize;
  const reserve = compressed ? gzipLimit(maxOutput) : 0;
  const peak = maxOutput + reserve + guard;
  if (!Number.isSafeInteger(peak)) throw new StorageAdmissionError('The SQLite backup size is too large');
  function requireSpace(additional) {
    const space = readSpace(directory);
    if (!space.available) throw new StorageAdmissionError('Cannot measure DATA free space; backup refused');
    if (space.available_bytes - (appliance ? space.maintenance_floor_bytes : 0) < additional) {
      throw new StorageAdmissionError('Not enough DATA free space for a backup while preserving maintenance headroom');
    }
  }
  const checkSpace = () => requireSpace(guard + reserve);
  const checkSize = size => {
    if (!Number.isSafeInteger(size) || size < 0 || size > maxOutput) {
      throw new StorageAdmissionError('The database grew beyond the admitted backup size; try again');
    }
  };
  requireSpace(peak);
  return {
    checkSpace,
    progress({ totalPages }) { checkSize(totalPages * pageSize); checkSpace(); },
    finish(file) { checkSize(fs.statSync(file).size); checkSpace(); }
  };
}

module.exports = { snapshotBudget, StorageAdmissionError, gzipLimit };
