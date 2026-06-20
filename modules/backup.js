const { logger } = require('./logger');
const fs = require('fs');
const { getDb, DB_PATH, initializeDatabase } = require('./database');
const { setupMqtt, mqttClients } = require('./mqtt');

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

/**
 * Verify a SQLite file is valid by opening it and SELECT 1.
 */
function isSqliteValid(filePath) {
  try {
    const Database = require('better-sqlite3');
    const testDb = new Database(filePath, { readonly: true });
    testDb.prepare('SELECT 1').get();
    testDb.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a safe snapshot copy of the current database into a temp file,
 * checkpointing the WAL first so the snapshot is self-consistent.
 */
function createBackupSnapshot(tmpPath) {
  checkpointWal();
  fs.copyFileSync(DB_PATH, tmpPath);
  if (!isSqliteValid(tmpPath)) {
    // WAL checkpoint may not fully flush on all configurations.
    // Try opening again with DELETE journal mode via a fresh connection.
    try {
      const Database = require('better-sqlite3');
      const tmpDb = new Database(DB_PATH);
      tmpDb.pragma('journal_mode = DELETE');
      tmpDb.close();
      fs.copyFileSync(DB_PATH, tmpPath);
    } catch (retryErr) {
      throw new Error('Backup snapshot invalid even after retry: ' + retryErr.message);
    }
    if (!isSqliteValid(tmpPath)) {
      throw new Error('Backup snapshot invalid — cannot create a consistent backup');
    }
  }
  return tmpPath;
}

async function backupDatabase(res) {
  const tmpPath = DB_PATH + '.backup-tmp';
  try {
    createBackupSnapshot(tmpPath);
    res.download(tmpPath, `energy-dashboard-backup-${Date.now()}.db`, (err) => {
      // Clean up temp snapshot after download completes (or fails)
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
      if (err) logger.error('Backup download error:', err);
    });
  } catch (err) {
    // Clean up on error
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    logger.error('Backup failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Backup failed: ' + err.message });
    }
  }
}

async function restoreDatabase(filePath) {
  const backupPath = DB_PATH + '.bak';

  // Step 1: validate uploaded file
  let testDb;
  try {
    const Database = require('better-sqlite3');
    testDb = new Database(filePath, { readonly: true });
    // Ensure the uploaded DB has the minimum schema
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const required = ['config', 'metrics', 'latest_metrics'];
    const hasAll = required.every(t => tables.some(r => r.name === t));
    if (!hasAll) {
      testDb.close();
      throw new Error('Uploaded database is missing required tables (config, metrics, latest_metrics)');
    }
    testDb.close();
    testDb = null;
  } catch (err) {
    if (testDb) try { testDb.close(); } catch (e) {}
    throw new Error('Uploaded file is not a valid Epilykos database: ' + err.message);
  }

  // Step 2: backup the current database before overwriting
  try {
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
    initializeDatabase();
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

module.exports = { backupDatabase, restoreDatabase };
