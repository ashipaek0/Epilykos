'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-budget-'));
const cwd = process.cwd(), realStatfs = fs.statfsSync;
process.chdir(dir); process.env.LOG_TO_FILE = 'false';
const database = require('../modules/database'); database.initializeDatabase();
const db = database.getDb();
const originalLock = process.env.EPILYKOS_MAINTENANCE_LOCK;
process.env.EPILYKOS_MAINTENANCE_LOCK = path.join(dir, 'data', '.maintenance.lock');
db.exec('CREATE TABLE payload(value BLOB)');
db.prepare('INSERT INTO payload VALUES(zeroblob(?))').run(8 * 1024 * 1024);
const backup = require('../modules/backup');
const GiB = 1073741824;
const stat = available => ({ bsize: 4096n, blocks: 2097152n, bavail: BigInt(available / 4096) }); // 8 GiB DATA
function response() {
  return Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, statusCode: 200,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
    download(file, name, options, done) { this.file = file; this.done = done; }
  });
}
function staged() { return fs.readdirSync(path.dirname(database.DB_PATH)).filter(f => f.startsWith('.backup-')); }
after(() => {
  if (originalLock) process.env.EPILYKOS_MAINTENANCE_LOCK = originalLock;
  else delete process.env.EPILYKOS_MAINTENANCE_LOCK;
  fs.statfsSync = realStatfs; db.close(); process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

test('backup refuses its projected peak before consuming the maintenance floor', async () => {
  fs.statfsSync = () => stat(GiB + 4 * 1024 * 1024);
  const res = response();
  try {
    await backup.backupDatabase(res);
    assert.equal(res.statusCode, 507);
    assert.match(res.body.error, /space|storage/i);
    assert.equal(res.file, undefined);
    assert.deepEqual(staged(), []);
    assert.equal(db.prepare('SELECT length(value) AS n FROM payload').get().n, 8388608);
  } finally { if (res.done) res.done(); }
});

test('unmeasurable DATA space fails closed and frees the job slot', async () => {
  fs.statfsSync = () => { throw new Error('storage unavailable'); };
  const res = response();
  try {
    await backup.backupDatabase(res);
    assert.equal(res.statusCode, 507);
    assert.equal(res.file, undefined);
    assert.deepEqual(staged(), []);
  } finally { if (res.done) res.done(); }
});

test('disk pressure after admission aborts the copy and preserves live data', async () => {
  let pressure = false, scheduled = false;
  fs.statfsSync = () => {
    if (!scheduled) { scheduled = true; setImmediate(() => { pressure = true; }); }
    return stat(pressure ? GiB : 4 * GiB);
  };
  const res = response();
  try {
    await backup.backupDatabase(res);
    assert.equal(pressure, true);
    assert.equal(res.statusCode, 507);
    assert.equal(res.file, undefined);
    assert.deepEqual(staged(), []);
    assert.equal(db.prepare('SELECT length(value) AS n FROM payload').get().n, 8388608);
  } finally { if (res.done) res.done(); }
});

test('admitted backup remains readable and retains the live WAL mode', async () => {
  fs.statfsSync = () => stat(4 * GiB);
  const res = response();
  try {
    await backup.backupDatabase(res);
    assert.equal(res.statusCode, 200);
    const copy = new Database(res.file, { readonly: true, fileMustExist: true });
    try { assert.equal(copy.prepare('SELECT length(value) AS n FROM payload').get().n, 8388608); }
    finally { copy.close(); }
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  } finally { if (res.done) res.done(); }
  assert.deepEqual(staged(), []);
});

test('live database growth cannot silently enlarge the admitted backup', async () => {
  let scheduled = false;
  fs.statfsSync = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => db.prepare('INSERT INTO payload VALUES(zeroblob(?))').run(32 * 1024 * 1024));
    }
    return stat(4 * GiB);
  };
  const res = response();
  try {
    await backup.backupDatabase(res);
    assert.equal(res.statusCode, 507);
    assert.match(res.body.error, /grew|size/i);
    assert.equal(res.file, undefined);
    assert.deepEqual(staged(), []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM payload').get().n, 2, 'monitoring writes remain in the live DB');
  } finally { if (res.done) res.done(); }
});

test('rejected daily snapshot retains both previous snapshots and cleans staging', async () => {
  const snapshotDir = path.join(path.dirname(database.DB_PATH), 'snapshots');
  fs.mkdirSync(snapshotDir);
  for (let n = 1; n <= 2; n++) {
    const file = path.join(snapshotDir, `prior-${n}.db`);
    const prior = new Database(file); prior.exec('CREATE TABLE retained(value); INSERT INTO retained VALUES(42)'); prior.close();
    fs.utimesSync(file, n, n);
  }
  fs.statfsSync = () => stat(GiB + 4 * 1024 * 1024);
  backup.startSnapshotScheduler();
  try {
    // Queue behind the scheduled capture; release means its attempt has finished.
    const release = await require('../modules/maintenanceLock').acquireLock('maintenance'); release();
    assert.deepEqual(backup.listSnapshots().map(s => s.name).sort(), ['prior-1.db', 'prior-2.db']);
    for (const file of fs.readdirSync(snapshotDir)) {
      const prior = new Database(path.join(snapshotDir, file), { readonly: true });
      try { assert.equal(prior.prepare('SELECT value FROM retained').get().value, 42); }
      finally { prior.close(); }
    }
  } finally { backup.stopSnapshotScheduler(); }
});

test('larger DATA filesystems retain the percentage floor rather than only one GiB', async () => {
  fs.statfsSync = () => ({ bsize: 4096n, blocks: 16777216n, bavail: 1048576n }); // 64 GiB total, 4 GiB available
  const res = response();
  try {
    await backup.backupDatabase(res);
    assert.equal(res.statusCode, 507);
    assert.equal(res.file, undefined);
    assert.deepEqual(staged(), []);
  } finally { if (res.done) res.done(); }
});

test('space pressure interrupts blocked native validation before publication', async () => {
  let pressure = false, reader, locked = false, pressureAt, pressureTimer;
  fs.statfsSync = () => stat(pressure ? GiB : 4 * GiB);
  const expectedSize = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  const hold = setInterval(() => {
    if (locked) return;
    const privateDir = staged()[0];
    if (!privateDir) return;
    const target = path.join(path.dirname(database.DB_PATH), privateDir, 'energy.db');
    try {
      if (fs.statSync(target).size !== expectedSize) return;
      reader = new Database(target, { fileMustExist: true, timeout: 1 });
      // WAL readers are not excluded by BEGIN EXCLUSIVE; use a DELETE-mode
      // captured fixture so this specifically blocks the validator's native read.
      reader.pragma('journal_mode = DELETE');
      reader.exec('BEGIN EXCLUSIVE'); locked = true;
      pressureTimer = setTimeout(() => { pressure = true; pressureAt = Date.now(); }, 250);
    } catch (_) { if (reader) reader.close(); reader = null; }
  }, 1);
  const res = response();
  try {
    await backup.backupDatabase(res);
    assert.equal(locked, true, 'validator faces an actual SQLite exclusive lock');
    assert.equal(res.statusCode, 507);
    assert.equal(res.file, undefined);
    assert.ok(Date.now() - pressureAt < 3000, 'space monitor interrupts native validation instead of waiting for its five-second busy timeout');
    assert.deepEqual(staged(), []);
  } finally {
    clearInterval(hold);
    clearTimeout(pressureTimer);
    if (reader) { reader.exec('ROLLBACK'); reader.close(); }
    if (res.done) res.done();
  }
});

test('ordinary deployments can back up on shared or small filesystems with adequate scratch', async () => {
  const lockFile = process.env.EPILYKOS_MAINTENANCE_LOCK;
  const hostSocket = process.env.EPILYKOS_HOST_SOCKET;
  delete process.env.EPILYKOS_HOST_SOCKET;
  delete process.env.EPILYKOS_MAINTENANCE_LOCK;
  try {
    for (const capacity of [
      { bsize: 4096n, blocks: 268435456n, bavail: 20971520n }, // 1 TiB total, 80 GiB free
      { bsize: 4096n, blocks: 131072n, bavail: 32768n } // 512 MiB total, 128 MiB free
    ]) {
      fs.statfsSync = () => capacity;
      const res = response();
      try {
        await backup.backupDatabase(res);
        assert.equal(res.statusCode, 200, 'OS-only headroom policy must not disable ordinary backups');
        assert.ok(fs.existsSync(res.file));
      } finally { if (res.done) res.done(); }
    }
  } finally {
    if (lockFile) process.env.EPILYKOS_MAINTENANCE_LOCK = lockFile;
    if (hostSocket) process.env.EPILYKOS_HOST_SOCKET = hostSocket;
  }
});
