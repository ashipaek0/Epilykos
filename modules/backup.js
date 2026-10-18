const { logger } = require('./logger');
const fs = require('fs');
const path = require('path');
const { getDb, DB_PATH, initializeDatabase, openPreparedDatabase, flushMetrics, setConfig } = require('./database');
const { setupMqtt, mqttClients } = require('./mqtt');
const { acquireLock } = require('./maintenanceLock');
const { emitEvent } = require('./notifications/events');
const { createBackupSnapshot } = require('./sqliteSnapshot');
const { prepareRestore } = require('./restorePreparation');

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

async function restorePreparedDatabaseUnlocked(filePath) {
  const backupPath = DB_PATH + '.bak';

  // Step 2: backup the current database before overwriting (drain queued
  // metric writes first so they land in the backup, not the restored DB)
  try {
    try { flushMetrics(); } catch (e) { logger.warn(`Restore: metric flush failed: ${e.message}`); }
    if (fs.existsSync(DB_PATH)) {
      checkpointWal();
      fs.copyFileSync(DB_PATH, backupPath);
    }
  } catch (err) {
    throw new Error('Failed to backup current database before restore: ' + err.message);
  }

  // Step 3: shutdown all running services that touch the database
  try {
    if (getDb()) getDb().close();
  } catch (e) {}
  for (const client of mqttClients.values()) {
    try { client.end(true); } catch (e) {}
  }
  mqttClients.clear();

  // Step 4: replace the database
  try {
    fs.copyFileSync(filePath, DB_PATH);
    openPreparedDatabase();
    setupMqtt();
    // Verify the restored DB is usable
    const restoredDb = getDb();
    restoredDb.prepare('SELECT 1 FROM metrics LIMIT 1').get();
    // Clean up backup on success
    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch (e) {}
    return { success: true };
  } catch (err) {
    // Restore failed — rollback to backup
    logger.error('Restore failed, rolling back:', err.message);
    try {
      if (getDb()) getDb().close();
    } catch (e) {}
    for (const client of mqttClients.values()) {
      try { client.end(true); } catch (e) {}
    }
    mqttClients.clear();
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, DB_PATH);
      try { fs.unlinkSync(backupPath); } catch (e) {}
    }
    initializeDatabase();
    setupMqtt();
    throw new Error('Restore failed, original database restored. ' + err.message);
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
