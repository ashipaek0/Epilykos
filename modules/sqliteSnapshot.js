'use strict';
const path = require('node:path');
const { snapshotBudget } = require('./snapshotBudget');
const { inspectSqliteFile } = require('./sqliteCheck');

async function createBackupSnapshot(db, destination, { signal, leaseFds = [], scratch, compressed = false } = {}) {
  signal?.throwIfAborted();
  const budget = snapshotBudget(db, path.dirname(destination), { compressed });
  // SQLite's online backup includes committed WAL data and copies incrementally
  // (better-sqlite3 defaults to 100 pages per event-loop turn). Use the normal
  // writer connection: its writes are reflected without restarting the copy.
  await db.backup(destination, { progress: progress => {
    signal?.throwIfAborted();
    budget.progress(progress);
  } });
  signal?.throwIfAborted();
  budget.finish(destination);
  await inspectSqliteFile(destination, { signal, checkSpace: budget.checkSpace, leaseFds, scratch });
  budget.finish(destination);
  signal?.throwIfAborted();
  return destination;
}

module.exports = { createBackupSnapshot };
