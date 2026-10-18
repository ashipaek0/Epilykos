const { logger } = require('./logger');
const fs = require('fs');
const path = require('path');
const { getDb, DB_PATH, openPreparedDatabase, flushMetrics, setConfig } = require('./database');
const { setupMqtt, mqttClients } = require('./mqtt');
const { acquireLock } = require('./maintenanceLock');
const { emitEvent } = require('./notifications/events');
const { createBackupSnapshot } = require('./sqliteSnapshot');
const { prepareRestore } = require('./restorePreparation');
const { beginRestoreSwap, recoverRestore, recoveryError } = require('./restoreTransaction');

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

async function backupDatabase(res) {
  if (activeDownloads >= MAX_BACKUP_DOWNLOADS) {
    return res.status(503).json({ error: 'Two backup downloads are already active. Finish or cancel one before trying again.' });
  }
  activeDownloads++;
  const controller = new AbortController();
  const disconnect = () => controller.abort(new Error('Backup download disconnected'));
  res.once('close', disconnect);
  if (res.destroyed) disconnect();
  let release, jobDir, handedOff = false, cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    res.removeListener('close', disconnect);
    if (jobDir) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); }
      catch (error) { logger.warn('Backup: cannot remove staging directory:', error.message); }
    }
    activeDownloads--;
  };
  try {
    release = await acquireLock('maintenance', { timeoutMs: MAINTENANCE_TIMEOUT_MS });
    controller.signal.throwIfAborted();
    jobDir = fs.mkdtempSync(path.join(path.dirname(DB_PATH), '.backup-'));
    const tmpPath = path.join(jobDir, 'energy.db');
    try { flushMetrics(); } catch (e) { logger.warn(`Backup: metric flush failed: ${e.message}`); }
    await createBackupSnapshot(getDb(), tmpPath, { signal: controller.signal });
    // This file is now immutable and private to this transfer. Holding the
    // maintenance lock during HTTP transfer would prevent restore for hours.
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
      logger.error('Backup failed:', err);
      if (!res.headersSent) res.status(err.code === 'INSUFFICIENT_STORAGE' ? 507 : 500).json({ error: 'Backup failed: ' + err.message });
    }
  } finally {
    if (release) release();
    if (!handedOff) cleanup();
  }
}

async function restoreDatabaseUnlocked(filePath) {
  const prepared = await prepareRestore(filePath, getDb(), DB_PATH);
  try { return await restorePreparedDatabaseUnlocked(prepared.filePath); }
  finally { prepared.cleanup(); }
}

function stopRestoreMqtt() {
  for (const client of mqttClients.values()) {
    client.removeAllListeners('message');
    try { client.end(true); } catch (_) {}
  }
  mqttClients.clear();
}

function restorePreparedDatabaseUnlocked(filePath) {
  const original = getDb();
  // No await in this activation section: all app SQLite calls share the main
  // thread/connection; workers and host maintenance are excluded by the lease.
  try {
    flushMetrics();
    // Unlike an unchecked wal_checkpoint result, this refuses live readers and
    // produces a standalone original before its inode can move.
    if (original.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Cannot checkpoint the live database');
    original.close();
  } catch (error) {
    if (original.open) { try { original.pragma('journal_mode = WAL'); } catch (_) {} }
    throw Object.assign(new Error('Restore cannot quiesce the live database: ' + error.message), {
      restorePreflight: true, status: error.code === 'SQLITE_BUSY' ? 409 : 500
    });
  }
  let transaction;
  try {
    stopRestoreMqtt();
    transaction = beginRestoreSwap(DB_PATH, filePath);
    openPreparedDatabase();
    setupMqtt();
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
    try { if (getDb().open) getDb().close(); } catch (_) {}
    stopRestoreMqtt();
    try {
      if (transaction) transaction.rollback();
      else recoverRestore(DB_PATH);
      openPreparedDatabase();
      setupMqtt();
    } catch (recovery) {
      throw recoveryError(recovery);
    }
    throw new Error('Restore failed, original database restored. ' + error.message);
  }
}

async function restoreDatabase(filePath) {
  const release = await acquireLock('maintenance', { timeoutMs: MAINTENANCE_TIMEOUT_MS });
  try { return await restoreDatabaseUnlocked(filePath); } finally { release(); }
}

// ── Daily Snapshot Scheduler ──────────────────────────────────────

let snapshotInterval = null;
const SNAPSHOT_CHECK_MS = 60 * 60 * 1000;  // check every hour
const SNAPSHOT_RETAIN = 2;                  // keep last 2
const SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000; // create one per day

function getSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return [];
    return fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(SNAPSHOT_DIR, f),
        time: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time); // newest first
  } catch (err) {
    logger.error('Snapshot: failed to list snapshots:', err.message);
    return [];
  }
}

function pruneSnapshots() {
  const snaps = getSnapshots();
  if (snaps.length <= SNAPSHOT_RETAIN) return;
  const toRemove = snaps.slice(SNAPSHOT_RETAIN);
  for (const s of toRemove) {
    try {
      fs.unlinkSync(s.path);
      logger.info(`Snapshot: pruned old snapshot ${s.name}`);
    } catch (err) {
      logger.warn(`Snapshot: failed to prune ${s.name}:`, err.message);
    }
  }
}

async function createSnapshotUnlocked() {
  const snapDir = SNAPSHOT_DIR;
  try {
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
  } catch (err) {
    logger.error('Snapshot: cannot create snapshot directory:', err.message);
    emitEvent('backup.snapshot_failed', { message: `Cannot create the snapshot folder: ${err.message}` });
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapPath = path.join(snapDir, `energy-snapshot-${stamp}.db`);

  let jobDir;
  try {
    jobDir = fs.mkdtempSync(path.join(snapDir, '.snapshot-'));
    const staged = path.join(jobDir, 'energy.db');
    await createBackupSnapshot(getDb(), staged);
    fs.renameSync(staged, snapPath);
    logger.info(`Snapshot: created ${snapPath}`);
    pruneSnapshots();
  } catch (err) {
    logger.error('Snapshot: creation failed:', err.message);
    emitEvent('backup.snapshot_failed', { message: `The daily snapshot failed: ${err.message}` });
  } finally {
    if (jobDir) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); }
      catch (error) { logger.warn('Snapshot: cannot remove staging directory:', error.message); }
    }
  }
}

async function createSnapshot() {
  let release;
  try {
    release = await acquireLock('maintenance', { timeoutMs: MAINTENANCE_TIMEOUT_MS });
  } catch (err) {
    logger.error('Snapshot: lock acquisition failed:', err.message);
    return;
  }

  try {
    try { flushMetrics(); } catch (e) { logger.warn(`Snapshot: metric flush failed: ${e.message}`); }
    return await createSnapshotUnlocked();
  } catch (err) {
    logger.error('Snapshot: creation failed:', err.message);
  } finally {
    if (release) release();
  }
}

function getLatestSnapshotTime() {
  const snaps = getSnapshots();
  return snaps.length > 0 ? snaps[0].time : 0;
}

function snapshotTick() {
  const latest = getLatestSnapshotTime();
  const age = Date.now() - latest;
  if (age >= SNAPSHOT_AGE_MS) {
    createSnapshot();
  }
}

function startSnapshotScheduler() {
  if (snapshotInterval) return;
  logger.info(`Snapshot scheduler started (daily, retain ${SNAPSHOT_RETAIN})`);
  // Run once on startup if no recent snapshot
  snapshotTick();
  // Then check every hour
  snapshotInterval = setInterval(snapshotTick, SNAPSHOT_CHECK_MS);
}

function stopSnapshotScheduler() {
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
    logger.info('Snapshot scheduler stopped');
  }
}

// ── Snapshot API ──────────────────────────────────────────────────

function listSnapshots() {
  return getSnapshots().map(s => ({
    name: s.name,
    time: new Date(s.time).toISOString(),
    size: fs.statSync(s.path).size
  }));
}

async function restoreFromSnapshot(snapshotName) {
  const snaps = getSnapshots();
  const match = snaps.find(s => s.name === snapshotName);
  if (!match) throw new Error(`Snapshot "${snapshotName}" not found`);
  return restoreDatabase(match.path);
}

module.exports = { backupDatabase, restoreDatabase, startSnapshotScheduler, stopSnapshotScheduler, listSnapshots, restoreFromSnapshot, checkpointWal };
