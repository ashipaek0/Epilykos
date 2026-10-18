'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { restorePreflight, restoreBudget } = require('./restorePreflight');
const { runSqliteProcess } = require('./sqliteCheck');
const { logger } = require('./logger');

async function prepareRestore(source, db, liveFile, { signal } = {}) {
  const before = fs.lstatSync(source);
  const input = await restorePreflight(source, db, liveFile, { signal });
  const directory = path.dirname(liveFile);
  let job, destination;
  const cleanup = () => {
    if (!job) return;
    // Once journaled, only the recovery protocol owns this directory; it can
    // contain the sole complete original. Never recursively remove it here.
    if (fs.existsSync(path.join(directory, '.restore-transaction.json'))) return;
    try { fs.rmSync(job, { recursive: true, force: true }); }
    catch (error) { logger.warn('Restore: cannot remove preparation staging:', error.message); }
  };
  const budget = restoreBudget(db, input.bytes, directory);
  const maxScratch = 2 * input.bytes + 32 * 1024 * 1024;
  function checkSpace() {
    budget();
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { bytes += fs.statSync(destination + suffix).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (bytes > maxScratch) throw Object.assign(new Error('Restore migration exceeded its scratch allocation'), { restorePreflight: true, status: 507 });
  }
  try {
    job = fs.mkdtempSync(path.join(directory, '.restore-'));
    destination = path.resolve(job, 'candidate.db');
    checkSpace();
    await runSqliteProcess('restorePrepareCheck.js', [path.resolve(source), destination], { signal, checkSpace });
    const after = fs.lstatSync(source);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('The backup changed during preparation');
    }
    checkSpace();
    // Replacement admission uses the actual migrated size, not the old input.
    restoreBudget(db, fs.statSync(destination).size, directory)();
    return { filePath: destination, cleanup };
  } catch (error) {
    cleanup(); // the child supervisor has already killed/reaped its process
    if (error.restorePreflight || signal?.aborted) throw error;
    throw Object.assign(new Error('Restore preparation failed: ' + error.message), {
      restorePreflight: true, status: ['ENOSPC', 'SQLITE_FULL'].includes(error.code) ? 507 : 400
    });
  }
}
module.exports = { prepareRestore };
