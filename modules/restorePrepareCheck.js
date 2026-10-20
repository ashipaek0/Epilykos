'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const database = require('./database');
const [source, destination] = process.argv.slice(2);
let handle, result;
try {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  database.initializeDatabase({ filePath: destination });
  handle = database.getDb();
  // Exercise the writes used for config and numeric/text telemetry. Roll back
  // both probes and their triggers so no synthetic readings enter the restore.
  const probe = '.restore-probe-' + randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  handle.exec('SAVEPOINT restore_write_probe');
  try {
    handle.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)').run(probe, 'probe');
    const metric = handle.prepare('INSERT INTO metrics(timestamp,metric,value,value_text,value_type) VALUES(?,?,?,?,?)');
    metric.run(timestamp, probe, 1.25, null, 'number');
    metric.run(timestamp + 1, probe, null, 'probe', 'string');
    const latest = handle.prepare('INSERT OR REPLACE INTO latest_metrics(metric,value,timestamp,unit,value_text,value_type) VALUES(?,?,?,?,?,?)');
    latest.run(probe, 1.25, timestamp, 'W', null, 'number');
    latest.run(probe, null, timestamp + 1, '', 'probe', 'string');
    if (handle.prepare('SELECT value FROM config WHERE key=?').get(probe)?.value !== 'probe'
        || handle.prepare('SELECT value FROM metrics WHERE timestamp=? AND metric=?').get(timestamp, probe)?.value !== 1.25
        || handle.prepare('SELECT value_text FROM metrics WHERE timestamp=? AND metric=?').get(timestamp + 1, probe)?.value_text !== 'probe'
        || handle.prepare('SELECT value_text FROM latest_metrics WHERE metric=?').get(probe)?.value_text !== 'probe') {
      throw new Error('Prepared database failed core write checks');
    }
  } finally { handle.exec('ROLLBACK TO restore_write_probe; RELEASE restore_write_probe'); }
  const rows = handle.pragma('quick_check');
  if (rows.length !== 1 || rows[0].quick_check !== 'ok') throw new Error('Prepared database failed SQLite quick_check');
  // Convert only this private copy to a standalone file; never touch the source.
  if (handle.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Cannot finalize prepared database');
  handle.close(); handle = null;
  const fd = fs.openSync(destination, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  result = { ok: true, bytes: fs.statSync(destination).size };
} catch (error) {
  result = { ok: false, error: error.message.slice(0, 512), code: error.code };
} finally {
  try { if (!handle) handle = database.getDb(); if (handle.open) handle.close(); } catch (_) {}
}
process.send(result, () => process.disconnect());
