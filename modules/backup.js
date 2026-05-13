const fs = require('fs');
const { getDb, DB_PATH, initializeDatabase } = require('./database');
const { setupMqtt, mqttClients } = require('./mqtt');

async function backupDatabase(res) {
  const db = getDb();
  if (db) db.close();
  res.download(DB_PATH, `energy-dashboard-backup-${Date.now()}.db`, (err) => {
    initializeDatabase();
    setupMqtt();
    if (err) console.error('Backup download error:', err);
  });
}

async function restoreDatabase(filePath) {
  const backupPath = DB_PATH + '.bak';
  try {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, backupPath);
    const testDb = new (require('better-sqlite3'))(filePath);
    testDb.prepare('SELECT 1').get();
    testDb.close();

    if (getDb()) getDb().close();
    for (const client of mqttClients.values()) client.end();
    mqttClients.clear();

    fs.copyFileSync(filePath, DB_PATH);
    initializeDatabase();
    setupMqtt();
    fs.unlinkSync(backupPath);
    return { success: true };
  } catch (err) {
    if (fs.existsSync(backupPath)) {
      if (getDb()) getDb().close();
      for (const client of mqttClients.values()) client.end();
      mqttClients.clear();
      fs.copyFileSync(backupPath, DB_PATH);
      fs.unlinkSync(backupPath);
      initializeDatabase();
      setupMqtt();
    }
    throw err;
  }
}

module.exports = { backupDatabase, restoreDatabase };
