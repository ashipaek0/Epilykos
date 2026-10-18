'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const SIDECARS = ['-wal', '-shm', '-journal'];

function paths(liveFile, job) {
  const live = path.resolve(liveFile), directory = path.dirname(live);
  return { live, directory, journal: path.join(directory, '.restore-transaction.json'),
    job: job && path.join(directory, job), candidate: job && path.join(directory, job, 'candidate.db'),
    original: job && path.join(directory, job, 'original.db') };
}
function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function regular(file) {
  const info = stat(file);
  if (!info?.isFile() || info.nlink !== 1n) throw new Error('Restore requires an unaliased regular file: ' + path.basename(file));
  return info;
}
function sync(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncParents(p) { sync(p.directory); if (stat(p.job)) sync(p.job); }
function writeJournal(p, record) {
  const temporary = path.join(p.directory, '.restore-journal-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    sync(temporary); fs.renameSync(temporary, p.journal); sync(p.directory);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function readJournal(liveFile) {
  const p = paths(liveFile);
  if (!stat(p.journal)) return null;
  if (regular(p.journal).size > 4096n) throw new Error('Restore journal is too large');
  const record = JSON.parse(fs.readFileSync(p.journal, 'utf8'));
  if (!record || record.schema !== 1 || !['pending', 'confirmed'].includes(record.phase)
      || typeof record.job !== 'string' || !/^\.restore-[A-Za-z0-9]{6}$/.test(record.job)
      || ![record.oldInode, record.newInode].every(value => typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value))
      || record.oldInode === record.newInode) throw new Error('Invalid restore journal');
  return record;
}
function match(file, inode) {
  const info = stat(file);
  if (!info) return false;
  return regular(file).ino.toString() === inode;
}
function checkJob(p) {
  const info = stat(p.job);
  if (info && !info.isDirectory()) throw new Error('Invalid restore staging directory');
}
function noSidecars(file) {
  if (SIDECARS.some(suffix => stat(file + suffix))) throw new Error('Restore file is not standalone');
}
function discardSidecars(file) {
  for (const suffix of SIDECARS) {
    if (stat(file + suffix)) { regular(file + suffix); fs.unlinkSync(file + suffix); }
  }
}
function finish(p, record) {
  // Only protocol-owned files are removable. Unknown contents fail closed.
  if (stat(p.candidate)) {
    if (!match(p.candidate, record.newInode)) throw new Error('Prepared restore inode changed');
    discardSidecars(p.candidate); fs.unlinkSync(p.candidate);
  }
  if (stat(p.job)) { fs.rmdirSync(p.job); sync(p.directory); }
  fs.unlinkSync(p.journal); sync(p.directory);
}

// Call before SQLite opens, with all owned DB handles closed. The shared
// maintenance lease serializes live restore; startup has one app DB owner.
function recoverRestore(liveFile) {
  const record = readJournal(liveFile);
  if (!record) return { recovered: false };
  const p = paths(liveFile, record.job); checkJob(p);
  if (record.phase === 'confirmed') {
    if (!match(p.live, record.newInode)) throw new Error('Confirmed restore database is missing or changed');
    // Keep its crash-recovery WAL; never attach it to an older database.
    if (stat(p.original)) {
      if (!match(p.original, record.oldInode)) throw new Error('Rollback database inode changed');
      noSidecars(p.original); fs.unlinkSync(p.original); sync(p.job);
    }
    finish(p, record);
    return { recovered: true, outcome: 'confirmed' };
  }
  if (stat(p.original)) {
    if (!match(p.original, record.oldInode)) throw new Error('Rollback database inode changed');
    noSidecars(p.original);
    if (stat(p.live)) {
      if (!match(p.live, record.newInode)) throw new Error('Unconfirmed live database inode changed');
      discardSidecars(p.live); // only this inode owns any candidate journals
    } else { noSidecars(p.live); }
    sync(p.directory);
    fs.renameSync(p.original, p.live); syncParents(p);
  } else if (!match(p.live, record.oldInode)) {
    throw new Error('No complete original database is available for restore recovery');
  } else { noSidecars(p.live); }
  finish(p, record);
  return { recovered: true, outcome: 'rolled_back' };
}

function recoveryError(error) {
  return Object.assign(new Error('Restore recovery is required before database use: ' + error.message), {
    restoreRecoveryRequired: true, status: 503, cause: error
  });
}

function beginRestoreSwap(liveFile, preparedFile) {
  const live = path.resolve(liveFile), candidate = path.resolve(preparedFile);
  const job = path.basename(path.dirname(candidate));
  const p = paths(live, job);
  if (!/^\.restore-[A-Za-z0-9]{6}$/.test(job) || candidate !== p.candidate) throw new Error('Invalid prepared restore path');
  if (stat(p.journal)) throw recoveryError(new Error('An earlier restore transaction remains'));
  checkJob(p);
  const original = regular(p.live), prepared = regular(p.candidate);
  if (original.dev !== prepared.dev || original.ino === prepared.ino || stat(p.original)) throw new Error('Invalid restore swap files');
  noSidecars(p.live); noSidecars(p.candidate);
  sync(p.live); sync(p.candidate); syncParents(p);
  const record = { schema: 1, phase: 'pending', job, oldInode: original.ino.toString(), newInode: prepared.ino.toString() };
  try {
    writeJournal(p, record);
    fs.renameSync(p.live, p.original); syncParents(p);
    fs.renameSync(p.candidate, p.live); syncParents(p);
  } catch (error) {
    try { recoverRestore(live); } catch (recovery) { throw recoveryError(recovery); }
    throw error;
  }
  let committed = false;
  return {
    commit() {
      writeJournal(p, { ...record, phase: 'confirmed' });
      committed = true;
      try { recoverRestore(live); return { cleanupPending: false }; }
      catch (_) { return { cleanupPending: true }; } // commit is already durable
    },
    rollback() {
      if (committed) throw new Error('Cannot roll back a confirmed restore');
      try {
        // Confirmation may have renamed its journal before a directory-sync
        // failure. Re-establish durable rollback intent before reverting it.
        if (readJournal(live)?.phase === 'confirmed') writeJournal(p, record);
        return recoverRestore(live);
      } catch (error) { throw recoveryError(error); }
    }
  };
}

module.exports = { beginRestoreSwap, recoverRestore, recoveryError };
