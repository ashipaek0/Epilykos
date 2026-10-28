const { logger } = require('./logger');
const fs = require('fs');
const path = require('path');
const { getDb, DB_PATH, openPreparedDatabase, flushMetrics, setConfig } = require('./database');
const { setupMqtt, mqttClients } = require('./mqtt');
const { acquireLock } = require('./maintenanceLock');
const { emitEvent } = require('./notifications/events');
const { createBackupSnapshot } = require('./sqliteSnapshot');
const { prepareRestore } = require('./restorePreparation');
const { createRestoreStaging, reapRestoreStaging } = require('./restoreStaging');
const { beginRestoreSwap, recoverRestore, recoveryError } = require('./restoreTransaction');
const databaseWork = require('./databaseWork');
const backupSecrets = require('./backupSecrets');

const MAINTENANCE_TIMEOUT_MS = 5000;
const SNAPSHOT_DIR = path.join(path.dirname(DB_PATH), 'snapshots');

/**
 * Checkpoint WAL so the main DB file is self-consistent.
 * Swallows errors — caller decides what to do with a corrupt DB.
 */
function checkpointWal() {
  try {
    const db = getDb();
    // TRUNCATE fully checkpoints and resets the WAL to 0 bytes
    db.pragma('wal_checkpoint(TRUNCATE)');
    return true;
  } catch (err) {
    logger.warn('Backup: WAL checkpoint failed:', err.message);
    return false;
  }
}

// Bound immutable downloads retained while slow clients transfer them. Capture
// remains serialized with restore/checks; transfer can proceed independently.
const MAX_BACKUP_DOWNLOADS = 2;
let activeDownloads = 0;

async function backupDatabase(res, { passphrase } = {}) {
  if (activeDownloads >= MAX_BACKUP_DOWNLOADS) {
    return res.status(503).json({ error: 'Two backup downloads are already active. Finish or cancel one before trying again.' });
  }
  activeDownloads++;
  const controller = new AbortController();
  const disconnect = () => controller.abort(new Error('Backup download disconnected'));
  res.once('close', disconnect);
  if (res.destroyed) disconnect();
  let release, job, handedOff = false, cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    res.removeListener('close', disconnect);
    if (job) {
      try { if (!job.cleanup()) logger.warn('Backup: staging retained for restore recovery'); }
      catch (error) { logger.warn('Backup: staging cleanup deferred: ' + error.message); }
    }
    activeDownloads--;
  };
  try {
    release = await acquireLock('maintenance', { timeoutMs: MAINTENANCE_TIMEOUT_MS, allowPendingOsUpdate: true });
    controller.signal.throwIfAborted();
    await reapRestoreStaging(path.dirname(DB_PATH), { signal: controller.signal });
    controller.signal.throwIfAborted();
    job = await createRestoreStaging(path.dirname(DB_PATH), { role: 'backup-download' });
    controller.signal.throwIfAborted();
    const tmpPath = path.join(job.directory, 'energy.db'), scratch = path.join(job.directory, 'scratch');
    fs.mkdirSync(scratch, { mode: 0o700 });
    try { flushMetrics(); } catch (e) { logger.warn(`Backup: metric flush failed: ${e.message}`); }
    await createBackupSnapshot(getDb(), tmpPath, { signal: controller.signal, scratch,
      leaseFds: [...(job.leaseFd === undefined ? [] : [job.leaseFd]), ...(release.leaseFd === undefined ? [] : [release.leaseFd])] });
    fs.chmodSync(tmpPath, 0o600);
    // With a passphrase, the copy's saved passwords are locked with it instead of this box's key.
    if (passphrase) { await backupSecrets.protect(tmpPath, passphrase); controller.signal.throwIfAborted(); }
    // This file is now immutable and private to this transfer. Holding the
    // maintenance lock during HTTP transfer would prevent restore for hours.
    // The private job lease remains live until the response transfer finishes.
    release(); release = null;
    res.download(tmpPath, `energy-dashboard-backup-${Date.now()}.db`, { dotfiles: 'allow' }, (err) => {
      if (cleaned) return;
      cleanup();
      if (err) {
        logger.error('Backup download error:', err);
        if (!res.headersSent && !res.destroyed) res.status(500).json({ error: 'Backup download failed' });
      }
      else { try { setConfig('backup_downloaded_at', new Date().toISOString()); } catch (e) { logger.warn('Cannot record backup download: ' + e.message); } }
    });
    handedOff = true;
  } catch (err) {
    if (!controller.signal.aborted) {
      if (err.code === 'LOCK_BUSY') {
        logger.info('Backup deferred: maintenance is already running');
        if (!res.headersSent) res.status(503).json({ error: 'A snapshot, backup or restore is already running. Wait for it to finish, then try again.' });
      } else if (err.code === 'PASSPHRASE_INVALID') {
        if (!res.headersSent) res.status(400).json({ error: err.message });
      } else {
        logger.error('Backup failed:', err);
        if (!res.headersSent) res.status(err.code === 'INSUFFICIENT_STORAGE' ? 507 : 500).json({ error: 'Backup failed: ' + err.message });
      }
    }
  } finally {
    if (release) release();
    if (!handedOff) cleanup();
  }
}

async function restoreDatabaseUnlocked(filePath, lifecycle, options) {
  const input = await require('./restoreInput').normalizeRestoreInput(filePath, getDb(), DB_PATH, options);
  let prepared;
  try {
    // A backup made with a passphrase asks for it before anything else happens.
    const marker = backupSecrets.inspect(input.filePath);
    let passphrase;
    if (marker) {
      if (!options.askPassphrase) throw Object.assign(new Error('This backup\'s saved passwords are protected by a passphrase. Restore it from Settings → Backup and restore, where you can enter it.'), { status: 400, restorePreflight: true });
      passphrase = await options.askPassphrase(marker);   // a string, or null to restore without the saved passwords
      options.signal?.throwIfAborted();
    }
    prepared = await prepareRestore(input.filePath, getDb(), DB_PATH, {
      ...options, leaseFds: [...options.leaseFds, ...(input.leaseFd === undefined ? [] : [input.leaseFd])]
    });
    // The candidate is a private copy: lock its secrets with this box's key before it can be selected.
    if (marker) await backupSecrets.unlock(prepared.filePath, marker, passphrase);
    return restorePreparedDatabaseUnlocked(prepared.filePath, lifecycle, options);
  } finally { prepared?.cleanup(); input.cleanup(); }
}

function stopRestoreMqtt() {
  for (const client of mqttClients.values()) {
    client.removeAllListeners('message');
    try { client.end(true); } catch (_) {}
  }
  mqttClients.clear();
}

function lifecycleCall(lifecycle, name) {
  const result = lifecycle[name]?.();
  if (result && typeof result.then === 'function') throw new Error('Restore runtime hooks must be synchronous');
}

function restorePreparedDatabaseUnlocked(filePath, lifecycle, options) {
  const original = getDb();
  // No await in this activation section: all app SQLite calls share the main
  // thread/connection; workers and host maintenance are excluded by the lease.
  try {
    options.signal?.throwIfAborted();
    lifecycleCall({ beforeActivate: () => options.beforeActivate?.({ liveFile: DB_PATH, preparedFile: filePath }) }, 'beforeActivate');
    databaseWork.run(() => lifecycleCall(lifecycle, 'pause'));
    flushMetrics();
    // Unlike an unchecked wal_checkpoint result, this refuses live readers and
    // produces a standalone original before its inode can move.
    if (original.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Cannot checkpoint the live database');
    original.close();
  } catch (error) {
    if (original.open) { try { original.pragma('journal_mode = WAL'); } catch (_) {} }
    try { databaseWork.run(() => lifecycleCall(lifecycle, 'resume')); }
    catch (resumeError) { throw recoveryError(resumeError); }
    throw Object.assign(new Error('Restore cannot quiesce the live database: ' + error.message), {
      restorePreflight: true, status: error.code === 'SQLITE_BUSY' ? 409 : 500
    });
  }
  databaseWork.retire();
  return databaseWork.run(() => activatePreparedDatabase(filePath, lifecycle, options));
}

function activatePreparedDatabase(filePath, lifecycle, options) {
  let transaction;
  try {
    stopRestoreMqtt();
    transaction = beginRestoreSwap(DB_PATH, filePath);
    openPreparedDatabase();
    setupMqtt();
    lifecycleCall(lifecycle, 'resume');
    lifecycleCall(options, 'afterActivate');
    const restoredDb = getDb();
    restoredDb.prepare('SELECT 1 FROM metrics LIMIT 1').get();
    const synchronous = restoredDb.pragma('synchronous', { simple: true });
    restoredDb.pragma('synchronous = FULL');
    const check = restoredDb.pragma('wal_checkpoint(TRUNCATE)');
    if (check[0].busy) throw new Error('Restored database checkpoint is busy');
    restoredDb.pragma('synchronous = ' + synchronous);
    const result = transaction.commit();
    if (result.cleanupPending) logger.warn('Restore confirmed; old-file cleanup will retry on startup');
    return { success: true };
  } catch (error) {
    try { lifecycleCall(lifecycle, 'pause'); } catch (pauseError) { logger.warn('Restore: runtime pause failed:', pauseError.message); }
    try { if (getDb().open) getDb().close(); } catch (_) {}
    stopRestoreMqtt();
    databaseWork.retire();
    return databaseWork.run(() => {
      try {
        if (transaction) transaction.rollback();
        else recoverRestore(DB_PATH);
        openPreparedDatabase();
        setupMqtt();
        lifecycleCall(lifecycle, 'resume');
      } catch (recovery) {
        try { if (getDb().open) getDb().close(); } catch (_) {}
        databaseWork.retire();
        throw recoveryError(recovery);
      }
      throw new Error('Restore failed, original database restored. ' + error.message);
    });
  }
}

async function restoreDatabase(filePath, { lifecycle = {}, signal, maintenanceLease, leaseFds = [], beforeActivate, afterActivate, askPassphrase } = {}) {
  const release = maintenanceLease || await acquireLock('maintenance', { timeoutMs: MAINTENANCE_TIMEOUT_MS });
  try {
    return await restoreDatabaseUnlocked(filePath, lifecycle, {
      signal, beforeActivate, afterActivate, askPassphrase,
      leaseFds: [...leaseFds, ...(release.leaseFd === undefined ? [] : [release.leaseFd])]
    });
  } finally { databaseWork.refresh(); if (!maintenanceLease) release(); }
}

// ── Daily Snapshot Scheduler ──────────────────────────────────────

let snapshotInterval = null, snapshotScheduler = null;
const snapshotFiles = require('./compressedSnapshots');
function getSnapshots() { return snapshotFiles.getSnapshots(SNAPSHOT_DIR); }
function startSnapshotScheduler() {
  if (snapshotScheduler) return;
  snapshotScheduler = require('./snapshotScheduler').createSnapshotScheduler({
    stateFile: path.join(path.dirname(DB_PATH), '.snapshot-retry.json'),
    latest: () => getSnapshots().find(s => s.managed) || null,
    healthy() { try { require('../routes/health').checkHealth(); return true; } catch (_) { return false; } },
    acquire: () => acquireLock('maintenance', { timeoutMs: 0, allowPendingOsUpdate: true }),
    async run(release, signal) {
      flushMetrics();
      const result = await snapshotFiles.createCompressedSnapshot(getDb(), SNAPSHOT_DIR, {
        signal, leaseFds: release.leaseFd === undefined ? [] : [release.leaseFd]
      });
      logger.info('Snapshot: created ' + result.name); return result;
    },
    warn(type, message) { logger.warn(message); emitEvent(type, { message }); }
  });
  const tick = () => databaseWork.run(() => snapshotScheduler?.tick());
  tick(); snapshotInterval = setInterval(tick, 60000); snapshotInterval.unref();
}
async function stopSnapshotScheduler() {
  clearInterval(snapshotInterval); snapshotInterval = null;
  const scheduler = snapshotScheduler;
  if (scheduler) await scheduler.stop();
  if (snapshotScheduler === scheduler) snapshotScheduler = null;
}
function snapshotStatus() { return snapshotScheduler?.status() || { phase: 'stopped', overdue: false, error: null }; }

// ── Snapshot API ──────────────────────────────────────────────────

function listSnapshots() {
  return getSnapshots().map(s => ({
    name: s.name,
    time: new Date(s.time).toISOString(),
    size: s.size,
    format: s.format
  }));
}

async function restoreFromSnapshot(snapshotName, options) {
  const snaps = getSnapshots();
  const match = snaps.find(s => s.name === snapshotName);
  if (!match) throw new Error(`Snapshot "${snapshotName}" not found`);
  return restoreDatabase(match.path, options);
}

module.exports = { backupDatabase, restoreDatabase, startSnapshotScheduler, stopSnapshotScheduler, listSnapshots, restoreFromSnapshot, checkpointWal, snapshotStatus };
