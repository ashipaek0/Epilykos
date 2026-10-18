'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-transaction-'));
const previousCwd = process.cwd();
process.chdir(root); process.env.LOG_TO_FILE = 'false';
process.env.ENC_KEY_FILE = path.join(root, 'key');
const database = require('../modules/database');
const backup = require('../modules/backup');
const core = `CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric));
CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);
INSERT INTO config VALUES('restore_probe','candidate');`;
function fresh() {
  try { database.getDb().close(); } catch (_) {}
  database.clearMetricBuffer();
  fs.rmSync('data', { recursive: true, force: true });
  database.initializeDatabase(); database.setConfig('restore_probe', 'original');
  const file = path.join(root, 'input-' + Math.random() + '.db');
  const input = new Database(file); input.exec(core); input.close();
  return file;
}
after(() => { try { database.getDb().close(); } catch (_) {} process.chdir(previousCwd); fs.rmSync(root, { recursive: true, force: true }); });

test('interruption during the first live-file mutation recovers a complete original on startup', () => {
  const directory = fs.mkdtempSync(path.join(root, 'death-'));
  const input = path.join(directory, 'input.db');
  const handle = new Database(input); handle.exec(core); handle.close();
  const child = spawnSync(process.execPath, ['-e', `
    process.env.LOG_TO_FILE='false'; process.chdir(process.argv[1]);
    const fs=require('node:fs'), path=require('node:path');
    const database=require(process.argv[2]);
    database.initializeDatabase(); database.setConfig('restore_probe','original');
    const live=path.resolve(database.DB_PATH), copy=fs.copyFileSync, rename=fs.renameSync;
    fs.copyFileSync=(from,to,...args)=>{
      if(path.resolve(to)===live){ fs.writeFileSync(to, 'partial database'); process.kill(process.pid,'SIGKILL'); }
      return copy(from,to,...args);
    };
    fs.renameSync=(from,to)=>{
      const result=rename(from,to);
      if(path.resolve(from)===live) process.kill(process.pid,'SIGKILL');
      return result;
    };
    require(process.argv[3]).restoreDatabase(process.argv[4]).catch(error=>{ console.error(error); process.exitCode=1; });
  `, directory, require.resolve('../modules/database'), require.resolve('../modules/backup'), input], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const restarted = spawnSync(process.execPath, ['-e', `
    process.env.LOG_TO_FILE='false'; process.chdir(process.argv[1]);
    const db=require(process.argv[2]); db.initializeDatabase();
    console.log('RESTORED:'+db.getConfig('restore_probe'));
    console.log('CHECK:'+db.getDb().pragma('quick_check',{simple:true})); db.getDb().close();
  `, directory, require.resolve('../modules/database')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.stdout, /RESTORED:original/);
  assert.match(restarted.stdout, /CHECK:ok/);
});

test('a busy WAL reader refuses activation without closing or changing the original', async () => {
  const input = fresh(); const original = database.getDb();
  original.pragma('busy_timeout=50');
  const reader = new Database(database.DB_PATH, { readonly: true });
  reader.exec('BEGIN'); reader.prepare('SELECT * FROM config').all();
  database.setConfig('restore_probe', 'newer WAL data');
  try {
    await assert.rejects(backup.restoreDatabase(input), error => error.restorePreflight && error.status === 409);
    assert.strictEqual(database.getDb(), original); assert.equal(original.open, true);
    assert.equal(database.getConfig('restore_probe'), 'newer WAL data');
  } finally { reader.exec('ROLLBACK'); reader.close(); }
});

test('a failed final telemetry flush retains its batch and refuses activation', async () => {
  const input = fresh(); const original = database.getDb();
  original.exec("CREATE TRIGGER reject_metric BEFORE INSERT ON metrics BEGIN SELECT RAISE(ABORT,'fixture flush failure'); END");
  database.queueMetricWrite({ metric: 'must survive', value: 42, timestamp: 1700000000 });
  await assert.rejects(backup.restoreDatabase(input), error => error.restorePreflight);
  assert.strictEqual(database.getDb(), original); assert.equal(original.open, true);
  assert.equal(database.getMetricBufferSize(), 1);
  original.exec('DROP TRIGGER reject_metric'); database.flushMetrics();
  assert.equal(original.prepare('SELECT value FROM metrics WHERE metric=?').get('must survive').value, 42);
});

test('activation health failure rolls back the complete original without candidate sidecars', async () => {
  const input = fresh();
  database.setConfig('restore_probe', 'original with WAL');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (path.basename(from) === 'candidate.db' && path.resolve(to) === path.resolve(database.DB_PATH)) fs.truncateSync(to, 0);
    return result;
  };
  try { await assert.rejects(backup.restoreDatabase(input), /original database restored/); }
  finally { fs.renameSync = rename; }
  assert.equal(database.getConfig('restore_probe'), 'original with WAL');
  assert.equal(database.getDb().pragma('quick_check', { simple: true }), 'ok');
  assert.equal(fs.existsSync(path.join('data', '.restore-transaction.json')), false);
});
