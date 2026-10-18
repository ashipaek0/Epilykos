'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-staging-integration-')), cwd = process.cwd();
process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.ENC_KEY_FILE = path.join(root, 'key');
const database = require('../modules/database');
const { prepareRestore } = require('../modules/restorePreparation');
const { restoreDatabase } = require('../modules/backup');
const { createRestoreStaging } = require('../modules/restoreStaging');
const { runSqliteProcess } = require('../modules/sqliteCheck');
function fixture() {
  try { database.getDb().close(); } catch (_) {} fs.rmSync('data', { recursive: true, force: true }); database.initializeDatabase();
  const input = path.join(root, 'input-' + Math.random() + '.db'), db = new Database(input);
  db.exec('CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric)); CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);');
  db.close(); return input;
}
after(() => { try { database.getDb().close(); } catch (_) {} process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });

test('SQLite children inherit staging ownership and place actual native temporary files on DATA', { skip: process.platform !== 'linux' }, async () => {
  fixture(); const job = await createRestoreStaging('data'), scratch = path.join(job.directory, 'scratch'); fs.mkdirSync(scratch, { mode: 0o700 });
  const previousLock = process.env.EPILYKOS_MAINTENANCE_LOCK;
  const hostLock = path.join(root, 'maintenance.lock'); process.env.EPILYKOS_MAINTENANCE_LOCK = hostLock;
  const release = await require('../modules/maintenanceLock').acquireLock('maintenance');
  try {
    const result = await runSqliteProcess('../test/fixtures/restore-scratch-probe.cjs', [], { leaseFds: [job.leaseFd, release.leaseFd], scratch });
    assert.equal(result.held, true); assert.equal(result.scratch, scratch);
    assert.ok(result.tempPaths.includes(hostLock), 'the SQLite child must retain the host maintenance lease');
    assert.ok(result.tempPaths.some(file => file.startsWith(scratch + '/etilqs_')), JSON.stringify(result.tempPaths));
  } finally { release(); if (previousLock === undefined) delete process.env.EPILYKOS_MAINTENANCE_LOCK; else process.env.EPILYKOS_MAINTENANCE_LOCK = previousLock; job.cleanup(); }
});

test('preparation publishes an owned job and confirmed activation removes its metadata', async () => {
  const input = fixture(), prepared = await prepareRestore(input, database.getDb(), database.DB_PATH);
  const job = path.dirname(prepared.filePath);
  try { assert.equal(JSON.parse(fs.readFileSync(path.join(job, 'owner.json'), 'utf8')).kind, 'restore-prepare'); assert.equal(fs.statSync(path.join(job, 'scratch')).isDirectory(), true); }
  finally { prepared.cleanup(); }
  assert.equal(fs.existsSync(job), false);
  assert.equal((await restoreDatabase(input)).success, true);
  assert.equal(fs.readdirSync('data').some(name => /^\.restore-[A-Za-z0-9]{6}$/.test(name)), false);
});

test('preparation reclaims provably abandoned jobs before capacity admission', { skip: process.platform !== 'linux' }, async () => {
  const input = fixture(), orphan = await createRestoreStaging('data'); fs.writeFileSync(path.join(orphan.directory, 'candidate.db'), 'abandoned'); orphan.release();
  const statfs = fs.statfsSync;
  fs.statfsSync = (...args) => { const result = statfs(...args); return fs.existsSync(orphan.directory) ? { ...result, bavail: 0 } : result; };
  let prepared;
  try { prepared = await prepareRestore(input, database.getDb(), database.DB_PATH); assert.equal(fs.existsSync(orphan.directory), false); }
  finally { fs.statfsSync = statfs; prepared?.cleanup(); }
});
