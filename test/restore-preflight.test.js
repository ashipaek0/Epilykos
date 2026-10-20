'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-preflight-'));
const cwd = process.cwd(); process.chdir(dir); process.env.LOG_TO_FILE = 'false';
const database = require('../modules/database');
const { restoreDatabase } = require('../modules/backup');
function live() {
  try { database.getDb().close(); } catch (_) {}
  fs.rmSync('data', { recursive: true, force: true });
  database.initializeDatabase(); database.setConfig('restore_probe', 'live data');
  return database.getDb();
}
function candidate(name, sql) {
  const file = path.join(dir, name);
  const db = new Database(file);
  db.exec(sql); db.close(); return file;
}
const core = `CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE metrics(timestamp INTEGER NOT NULL, metric TEXT NOT NULL, value REAL, PRIMARY KEY(timestamp,metric));
  CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);
  INSERT INTO config VALUES('restore_probe','candidate');`;
after(() => { try { database.getDb().close(); } catch (_) {} process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

test('incompatible core columns are rejected before closing or changing the live DB', async () => {
  const original = live();
  const file = candidate('wrong-schema.db', 'CREATE TABLE config(x); CREATE TABLE metrics(x); CREATE TABLE latest_metrics(x)');
  await assert.rejects(restoreDatabase(file));
  assert.strictEqual(database.getDb(), original);
  assert.equal(original.open, true);
  assert.equal(database.getConfig('restore_probe'), 'live data');
  assert.equal(fs.existsSync(database.DB_PATH + '.bak'), false);
});

test('corruption in an unused table cannot become the active database', async () => {
  const original = live();
  const file = candidate('corrupt.db', core + 'CREATE TABLE damaged(value); INSERT INTO damaged VALUES(1)');
  const broken = new Database(file);
  const root = broken.prepare("SELECT rootpage FROM sqlite_schema WHERE name='damaged'").get().rootpage;
  const pageSize = broken.pragma('page_size', { simple: true }); broken.close();
  const fd = fs.openSync(file, 'r+');
  try { fs.writeSync(fd, Buffer.from([255]), 0, 1, (root - 1) * pageSize); } finally { fs.closeSync(fd); }
  await assert.rejects(restoreDatabase(file));
  assert.strictEqual(database.getDb(), original);
  assert.equal(database.getConfig('restore_probe'), 'live data');
});

test('a database declaring an unknown format version is rejected before replacement', async () => {
  const original = live();
  const file = candidate('future.db', core + 'PRAGMA user_version = 99');
  await assert.rejects(restoreDatabase(file), /version|format/i);
  assert.strictEqual(database.getDb(), original);
  assert.equal(database.getConfig('restore_probe'), 'live data');
});

test('insufficient DATA headroom refuses restore before rollback copy or database close', async () => {
  const original = live();
  const file = candidate('space.db', core);
  const real = fs.statfsSync;
  const previous = process.env.EPILYKOS_MAINTENANCE_LOCK;
  process.env.EPILYKOS_MAINTENANCE_LOCK = path.join(dir, 'data', '.maintenance.lock');
  fs.statfsSync = () => ({ bsize: 4096n, blocks: 2097152n, bavail: 262144n }); // 8 GiB total, 1 GiB free
  try {
    await assert.rejects(restoreDatabase(file), error => error.status === 507);
    assert.strictEqual(database.getDb(), original);
    assert.equal(database.getConfig('restore_probe'), 'live data');
    assert.equal(fs.existsSync(database.DB_PATH + '.bak'), false);
  } finally { fs.statfsSync = real; if (previous) process.env.EPILYKOS_MAINTENANCE_LOCK = previous; else delete process.env.EPILYKOS_MAINTENANCE_LOCK; }
});

test('live growth during validation is included in the rollback allocation', async () => {
  const original = live();
  const file = candidate('growth-budget.db', core);
  const real = fs.statfsSync, previous = process.env.EPILYKOS_MAINTENANCE_LOCK;
  process.env.EPILYKOS_MAINTENANCE_LOCK = path.join(dir, 'data', '.maintenance.lock');
  let scheduled = false;
  fs.statfsSync = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => original.exec('CREATE TABLE restore_growth(value); INSERT INTO restore_growth VALUES(zeroblob(67108864))'));
    }
    return { bsize: 4096n, blocks: 2097152n, bavail: 282624n }; // 1 GiB floor + 80 MiB
  };
  try {
    await assert.rejects(restoreDatabase(file), error => error.status === 507);
    assert.strictEqual(database.getDb(), original);
    assert.equal(database.getConfig('restore_probe'), 'live data');
  } finally { fs.statfsSync = real; if (previous) process.env.EPILYKOS_MAINTENANCE_LOCK = previous; else delete process.env.EPILYKOS_MAINTENANCE_LOCK; }
});

test('legacy core schema validates asynchronously without changing input or live data', async () => {
  const original = live(); const file = candidate('legacy.db', core);
  const before = fs.readFileSync(file);
  let ticks = 0; const heartbeat = setInterval(() => { ticks++; }, 1);
  try {
    const result = await require('../modules/restorePreflight').restorePreflight(file, original, database.DB_PATH);
    assert.equal(result.ok, true); assert.equal(result.user_version, 0);
    assert.equal(result.bytes, before.length);
    assert.ok(ticks > 0, 'validation permits the monitoring event loop to run');
    assert.deepEqual(fs.readFileSync(file), before);
    assert.strictEqual(database.getDb(), original);
    assert.equal(database.getConfig('restore_probe'), 'live data');
  } finally { clearInterval(heartbeat); }
});

test('symlink, live input and sidecar-dependent backups are refused untouched', async () => {
  const original = live(); const file = candidate('dependent.db', core);
  const link = path.join(dir, 'link.db'); fs.symlinkSync(file, link);
  await assert.rejects(restoreDatabase(link), error => error.restorePreflight && error.status === 400);
  await assert.rejects(restoreDatabase(database.DB_PATH), error => error.restorePreflight && error.status === 400);
  fs.writeFileSync(file + '-wal', 'must not be deleted');
  await assert.rejects(restoreDatabase(file), /sidecar/i);
  assert.equal(fs.readFileSync(file + '-wal', 'utf8'), 'must not be deleted');
  assert.strictEqual(database.getDb(), original);
});

test('primary-key incompatibility is rejected before live replacement', async () => {
  const original = live();
  const file = candidate('no-pk.db', core.replace('PRIMARY KEY(timestamp,metric)', 'UNIQUE(timestamp,metric)'));
  await assert.rejects(restoreDatabase(file), /primary key/i);
  assert.strictEqual(database.getDb(), original);
});

test('incompatible core type affinity is rejected before closing the live database', async () => {
  const original = live();
  const file = candidate('integer-config-key.db', core.replace('key TEXT PRIMARY KEY', 'key INTEGER PRIMARY KEY').replace("INSERT INTO config VALUES('restore_probe','candidate');", ''));
  await assert.rejects(restoreDatabase(file), error => error.restorePreflight && error.status === 400 && /affinity|type/i.test(error.message));
  assert.strictEqual(database.getDb(), original);
  assert.equal(original.open, true);
  assert.equal(database.getConfig('restore_probe'), 'live data');
});

test('equivalent SQLite type names remain accepted', async () => {
  const original = live();
  const file = candidate('affinity-aliases.db', core.replaceAll('TEXT', 'VARCHAR(255)').replaceAll('INTEGER', 'BIGINT').replaceAll('REAL', 'DOUBLE PRECISION'));
  const result = await require('../modules/restorePreflight').restorePreflight(file, original, database.DB_PATH);
  assert.equal(result.ok, true);
  assert.strictEqual(database.getDb(), original);
});

test('cancelling blocked native preflight waits for checker exit and leaves the live DB open', async () => {
  const original = live(); const file = candidate('cancel.db', core);
  const holder = new Database(file); holder.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancel preflight')), 250);
  const start = Date.now();
  try {
    await assert.rejects(require('../modules/restorePreflight').restorePreflight(file, original, database.DB_PATH, { signal: controller.signal }), /cancel preflight/);
    assert.ok(Date.now() - start < 1500, 'native read is killed, not left to its five-second timeout');
    assert.strictEqual(database.getDb(), original); assert.equal(original.open, true);
  } finally { clearTimeout(timer); holder.exec('ROLLBACK'); holder.close(); }
});

test('standalone WAL-mode backup validates without leaving checker sidecars', async () => {
  const original = live(); const file = candidate('standalone-wal.db', core + 'PRAGMA journal_mode = WAL');
  const before = fs.readFileSync(file);
  await require('../modules/restorePreflight').restorePreflight(file, original, database.DB_PATH);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(file + suffix), false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(database.getConfig('restore_probe'), 'live data');
});

test('an accepted legacy backup still restores and receives additive schema migrations', async () => {
  live(); const file = candidate('accepted-legacy.db', core);
  const result = await restoreDatabase(file);
  assert.equal(result.success, true);
  assert.equal(database.getConfig('restore_probe'), 'candidate');
  assert.ok(database.getDb().pragma('table_info(latest_metrics)').some(column => column.name === 'unit'));
  assert.equal(fs.existsSync(database.DB_PATH + '.bak'), false);
});
