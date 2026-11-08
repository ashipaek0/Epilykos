'use strict';
/**
 * Give back the space the retention rollup frees.
 *
 * Deleting old raw rows leaves free pages inside the database file; SQLite
 * never returns them on its own, so a database that once held a lot of raw
 * history stays that size for good (and so does every backup of it, which
 * then needs a lot of free space to restore). This runs after the hourly
 * rollup and, when at least a quarter of the file (and 64 MiB) is free pages:
 *
 *  - if the database is in incremental auto-vacuum mode, releases the free
 *    pages in small batches, yielding to the event loop between them;
 *  - otherwise runs one full VACUUM, which also switches the file to
 *    incremental mode, so later runs are the cheap kind. A full VACUUM
 *    rewrites the file, so it only runs when DATA has room for that.
 *
 * New databases are created in incremental mode (database.js).
 */
const path = require('node:path');
const { getDb, DB_PATH } = require('./database');
const { acquireLock } = require('./maintenanceLock');
const { readSpace } = require('./storageStatus');
const { logger } = require('./logger');

const MiB = 1024 * 1024;
const MIN_FREE_RATIO = 0.25;
const MIN_FREE_BYTES = 64 * MiB;
const BATCH_PAGES = 4000;        // pages released per turn of the event loop
const BUDGET_MS = 20 * 1000;     // incremental work per run; the rest waits for the next one
const AUTO_VACUUM_INCREMENTAL = 2;

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

function readStats(db) {
  const pageSize = db.pragma('page_size', { simple: true });
  const pages = db.pragma('page_count', { simple: true });
  const free = db.pragma('freelist_count', { simple: true });
  return {
    pageSize, pages, free,
    autoVacuum: db.pragma('auto_vacuum', { simple: true }),
    fileBytes: pages * pageSize, freeBytes: free * pageSize, usedBytes: (pages - free) * pageSize
  };
}

function worthIt(stats, { minFreeBytes = MIN_FREE_BYTES, minFreeRatio = MIN_FREE_RATIO } = {}) {
  return stats.free > 0 && stats.freeBytes >= minFreeBytes && stats.free >= minFreeRatio * stats.pages;
}

const gib = bytes => (bytes / (1024 * MiB)).toFixed(1) + ' GiB';

/**
 * Reclaim free pages if the database has enough of them. Resolves with what it
 * did: { action: 'none' | 'incremental' | 'vacuum' | 'skipped', ... }.
 */
async function compactOnce(options = {}) {
  const db = options.db || getDb();
  const directory = options.directory || path.dirname(DB_PATH);
  if (!worthIt(readStats(db), options)) return { action: 'none' };

  let release;
  try {
    release = await acquireLock('maintenance', { timeoutMs: options.lockTimeoutMs, allowPendingOsUpdate: true });
  } catch (error) {
    if (/timed out/i.test(error.message) || error.code === 'LOCK_BUSY') return { action: 'skipped', reason: 'busy' };
    throw error;
  }
  try {
    const before = readStats(db);
    if (!worthIt(before, options)) return { action: 'none' };
    const started = Date.now();

    if (before.autoVacuum === AUTO_VACUUM_INCREMENTAL) {
      const budgetMs = options.budgetMs || BUDGET_MS;
      for (;;) {
        db.pragma(`incremental_vacuum(${BATCH_PAGES})`);
        if (db.pragma('freelist_count', { simple: true }) === 0) break;
        if (Date.now() - started >= budgetMs) break;
        await yieldToEventLoop();
      }
      db.pragma('wal_checkpoint(TRUNCATE)');
      const after = readStats(db);
      logger.info(`Database: released ${gib(before.fileBytes - after.fileBytes)} of free space (file now ${gib(after.fileBytes)})`);
      return { action: 'incremental', before, after };
    }

    // A full VACUUM builds the new file in the WAL next to the old one.
    const space = readSpace(directory);
    const floor = space.available ? space.maintenance_floor_bytes : 0;
    const needed = 2 * before.usedBytes + 32 * MiB;
    if (!space.available || space.available_bytes - floor < needed) {
      if (!options.quiet) logger.warn(`Database: ${gib(before.freeBytes)} of the ${gib(before.fileBytes)} file is unused, but compacting needs about ${gib(needed)} free on DATA first`);
      return { action: 'skipped', reason: 'space', before, needed };
    }
    logger.info(`Database: compacting ${gib(before.fileBytes)} file (${gib(before.freeBytes)} unused). Dashboard updates pause until this finishes.`);
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const after = readStats(db);
    logger.info(`Database: compacted to ${gib(after.fileBytes)} in ${Math.round((Date.now() - started) / 1000)} s`);
    return { action: 'vacuum', before, after };
  } finally {
    release();
  }
}

module.exports = { compactOnce, readStats, worthIt, MIN_FREE_RATIO, MIN_FREE_BYTES };
