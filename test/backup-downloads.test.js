'use strict';
// Real SQLite/WAL and filesystem; the response double delays only HTTP transfer completion.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-backup-'));
const originalCwd = process.cwd();
process.chdir(dir);
process.env.LOG_TO_FILE = 'false';
const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
db.pragma('busy_timeout = 1');
db.exec('CREATE TABLE backup_probe(id INTEGER PRIMARY KEY, value TEXT)');
const { backupDatabase } = require('../modules/backup');

function response() {
  return Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    download(file, name, options, done) { this.file = file; this.name = name; this.done = done; }
  });
}
function readProbe(file) {
  const snapshot = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(snapshot.pragma('quick_check'), [{ quick_check: 'ok' }]);
    return snapshot.prepare('SELECT id, value FROM backup_probe ORDER BY id').all();
  } finally { snapshot.close(); }
}
after(() => {
  db.close(); process.chdir(originalCwd); fs.rmSync(dir, { recursive: true, force: true });
});

test('download includes committed WAL changes even when a reader prevents checkpointing', async () => {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const reader = new Database(database.DB_PATH, { readonly: true });
  reader.exec('BEGIN'); reader.prepare('SELECT * FROM backup_probe').all();
  db.prepare('INSERT INTO backup_probe VALUES(?, ?)').run(1, 'committed in WAL');
  const res = response();
  try {
    await backupDatabase(res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(readProbe(res.file), [{ id: 1, value: 'committed in WAL' }]);
  } finally { if (res.done) res.done(); reader.exec('ROLLBACK'); reader.close(); }
});

test('finishing an overlapping download cannot delete another download', async () => {
  const first = response(), second = response();
  try {
    await backupDatabase(first);
    db.prepare('INSERT INTO backup_probe VALUES(?, ?)').run(2, 'second capture');
    await backupDatabase(second);
    assert.notEqual(first.file, second.file);
    assert.equal(readProbe(first.file).length, 1);
    assert.equal(readProbe(second.file).length, 2);
    const firstDir = path.dirname(first.file), secondDir = path.dirname(second.file);
    assert.equal(fs.statSync(firstDir).mode & 0o777, 0o700, 'backup directory is private');
    first.done();
    assert.equal(fs.existsSync(firstDir), false);
    assert.equal(readProbe(second.file).length, 2);
    second.done();
    assert.equal(fs.existsSync(secondDir), false);
  } finally { if (first.done) first.done(); if (second.done) second.done(); }
});

test('capture yields to monitoring writes and returns a transactionally valid database', async () => {
  db.exec('CREATE TABLE backup_payload(value BLOB)');
  db.prepare('INSERT INTO backup_payload VALUES(zeroblob(?))').run(8 * 1024 * 1024);
  const res = response(); let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks++;
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO backup_probe VALUES(?, ?)').run(3, String(ticks));
      db.prepare('INSERT OR REPLACE INTO backup_probe VALUES(?, ?)').run(4, String(ticks));
    })();
  }, 1);
  try {
    await backupDatabase(res);
    assert.equal(res.statusCode, 200);
    assert.ok(ticks > 0, 'dashboard event loop runs during capture/check');
    const rows = readProbe(res.file).filter(row => row.id >= 3);
    assert.equal(rows.length === 0 || (rows.length === 2 && rows[0].value === rows[1].value), true);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  } finally { clearInterval(heartbeat); if (res.done) res.done(); }
});

test('disconnect during capture cancels publication and removes private staging', async () => {
  const res = response();
  const abort = setTimeout(() => { res.destroyed = true; res.emit('close'); }, 0);
  try {
    await backupDatabase(res);
    assert.equal(res.file, undefined, 'never start a download to a disconnected client');
    assert.equal(res.body, undefined, 'never send an error to a disconnected client');
    assert.deepEqual(fs.readdirSync(path.dirname(database.DB_PATH)).filter(f => f.startsWith('.backup-')), []);
  } finally { clearTimeout(abort); if (res.done) res.done(); }
});

test('retained downloads are bounded and a finished download permits another', async () => {
  const first = response(), second = response(), rejected = response(), next = response();
  try {
    await backupDatabase(first); await backupDatabase(second); await backupDatabase(rejected);
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.file, undefined);
    assert.ok(fs.existsSync(first.file) && fs.existsSync(second.file));
    first.done();
    await backupDatabase(next);
    assert.equal(next.statusCode, 200);
    assert.equal(readProbe(next.file).length, 4);
  } finally { for (const res of [first, second, rejected, next]) if (res.done) res.done(); }
});

test('HTTP disconnect during streaming releases staging and a download slot', async () => {
  const http = require('node:http');
  const express = require('express');
  const app = express();
  app.get('/backup', (req, res) => backupDatabase(res));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const first = response(), second = response();
  try {
    await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${server.address().port}/backup`, { timeout: 5000 }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        res.pause();
        res.destroy(); request.destroy(); resolve();
      });
      request.once('error', reject);
      request.once('timeout', () => request.destroy(new Error('Backup response timed out')));
    });
    for (let n = 0; n < 100; n++) {
      if (!fs.readdirSync(path.dirname(database.DB_PATH)).some(f => f.startsWith('.backup-'))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(fs.readdirSync(path.dirname(database.DB_PATH)).filter(f => f.startsWith('.backup-')), []);
    await backupDatabase(first); await backupDatabase(second);
    assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
  } finally {
    if (first.done) first.done(); if (second.done) second.done();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('download errors clean up without recording a successful backup', async () => {
  database.setConfig('backup_downloaded_at', 'previous-success');
  const res = response();
  await backupDatabase(res);
  const directory = path.dirname(res.file);
  res.done(new Error('test disconnected transfer'));
  assert.equal(fs.existsSync(directory), false);
  assert.equal(database.getConfig('backup_downloaded_at'), 'previous-success');
});

test('daily snapshot becomes visible only after capture validates, before pruning older files', async () => {
  const backup = require('../modules/backup');
  const snaps = path.join(path.dirname(database.DB_PATH), 'snapshots');
  fs.mkdirSync(snaps, { recursive: true });
  for (let n = 1; n <= 2; n++) {
    const file = path.join(snaps, `energy-snapshot-2020-01-0${n}T00-00-00.db`);
    await db.backup(file);
    fs.utimesSync(file, n, n);
  }
  backup.startSnapshotScheduler();
  try {
    // Starting a capture must not expose an unfinished .db or prune a known-good file.
    assert.equal(backup.listSnapshots().length, 2);
    for (let n = 0; n < 200 && !backup.listSnapshots().some(s => s.format === 'gzip'); n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const published = backup.listSnapshots();
    assert.equal(published.length, 2);
    assert.ok(published.some(s => s.name === 'energy-snapshot-2020-01-02T00-00-00.db'));
    const latest = published.find(s => s.format === 'gzip');
    assert.ok(latest);
    const expanded = path.join(dir,'restored-snapshot.db');
    await require('node:stream/promises').pipeline(fs.createReadStream(path.join(snaps,latest.name)),require('node:zlib').createGunzip(),fs.createWriteStream(expanded));
    assert.equal(readProbe(expanded).length,4);
    assert.deepEqual(fs.readdirSync(snaps).filter(f => f.startsWith('.snapshot-')), []);
  } finally { await backup.stopSnapshotScheduler(); }
});
