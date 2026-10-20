'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-prepare-'));
const previousCwd = process.cwd();
process.chdir(root); process.env.LOG_TO_FILE = 'false';
process.env.ENC_KEY_FILE = path.join(root, 'encryption-key');
const database = require('../modules/database');
const { restoreDatabase } = require('../modules/backup');
const core = `CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE metrics(timestamp INTEGER NOT NULL, metric TEXT NOT NULL, value REAL, PRIMARY KEY(timestamp,metric));
CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);
INSERT INTO config VALUES('restore_probe','candidate');`;
function live() {
  try { database.getDb().close(); } catch (_) {}
  fs.rmSync('data', { recursive: true, force: true });
  database.initializeDatabase(); database.setConfig('restore_probe', 'original');
  return database.getDb();
}
function candidate(name, sql = core) {
  const file = path.join(root, name); const handle = new Database(file);
  handle.exec(sql); handle.close(); return file;
}
function assertOriginal(handle) {
  assert.strictEqual(database.getDb(), handle);
  assert.equal(handle.open, true);
  assert.equal(database.getConfig('restore_probe'), 'original');
  assert.equal(fs.existsSync(database.DB_PATH + '.bak'), false);
  assert.equal(fs.readdirSync('data').some(name => name.startsWith('.restore-')), false);
}
after(() => { try { database.getDb().close(); } catch (_) {} process.chdir(previousCwd); fs.rmSync(root, { recursive: true, force: true }); });

test('an optional-table migration failure is rejected before closing the original', async () => {
  const original = live();
  const input = candidate('bad-history.db', core + 'CREATE TABLE history(unrelated TEXT)');
  const before = fs.readFileSync(input);
  await assert.rejects(restoreDatabase(input), error => error.restorePreflight && error.status === 400);
  assertOriginal(original); assert.deepEqual(fs.readFileSync(input), before);
});

test('a candidate CHECK constraint failing real initialization never reaches live replacement', async () => {
  const original = live();
  const input = candidate('bad-constraint.db', core.replace('key TEXT PRIMARY KEY', "key TEXT PRIMARY KEY CHECK(key != 'dashboard_active')"));
  await assert.rejects(restoreDatabase(input), error => error.restorePreflight && error.status === 400);
  assertOriginal(original);
});

test('core write constraints incompatible with text telemetry are rejected before live closure', async () => {
  const original = live();
  const input = candidate('no-null-telemetry.db', core.replaceAll('value REAL', 'value REAL NOT NULL'));
  await assert.rejects(restoreDatabase(input), error => error.restorePreflight && error.status === 400);
  assertOriginal(original);
});

test('activation opens the prepared candidate without rerunning initialization', async () => {
  live();
  const input = candidate('once-only.db', core + `CREATE TRIGGER once_init BEFORE INSERT ON config
    WHEN NEW.key='dashboard_title' AND EXISTS(SELECT 1 FROM config WHERE key='dashboard_title' AND value!='')
    BEGIN SELECT RAISE(ABORT, 'second initialization'); END;`);
  assert.equal((await restoreDatabase(input)).success, true);
  assert.equal(database.getConfig('restore_probe'), 'candidate');
});

test('ENOSPC creating preparation staging rejects as preflight507 without rebinding', async () => {
  const original = live(); const input = candidate('staging-full.db');
  const make = fs.mkdtempSync;
  fs.mkdtempSync = () => { throw Object.assign(new Error('staging full'), { code: 'ENOSPC' }); };
  try {
    await assert.rejects(restoreDatabase(input), error => error.restorePreflight && error.status === 507);
    assertOriginal(original);
  } finally { fs.mkdtempSync = make; }
});

test('preparation migrates a private copy asynchronously and leaves the input and live handle intact', async () => {
  const original = live(); const input = candidate('legacy.db');
  const before = fs.readFileSync(input);
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  let prepared;
  try {
    prepared = await require('../modules/restorePreparation').prepareRestore(input, original, database.DB_PATH);
    assert.ok(ticks > 0);
    assert.equal(fs.statSync(path.dirname(prepared.filePath)).mode & 0o777, 0o700);
    const handle = new Database(prepared.filePath, { readonly: true });
    try {
      assert.ok(handle.pragma('table_info(latest_metrics)').some(column => column.name === 'unit'));
      assert.equal(handle.prepare("SELECT value FROM config WHERE key='restore_probe'").get().value, 'candidate');
      assert.equal(handle.pragma('quick_check', { simple: true }), 'ok');
    } finally { handle.close(); }
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(prepared.filePath + suffix), false);
    assert.deepEqual(fs.readFileSync(input), before);
    assert.strictEqual(database.getDb(), original);
    assert.equal(database.getConfig('restore_probe'), 'original');
  } finally { clearInterval(timer); if (prepared) prepared.cleanup(); }
  assertOriginal(original);
});

test('preparation pressure is rejected and staging is removed without closing the original', async () => {
  const original = live(); const input = candidate('pressure.db');
  const real = fs.statfsSync; const prior = process.env.EPILYKOS_MAINTENANCE_LOCK;
  process.env.EPILYKOS_MAINTENANCE_LOCK = path.join(root, 'data', '.maintenance.lock');
  fs.statfsSync = () => {
    const allocated = fs.readdirSync('data').some(name => name.startsWith('.restore-') && fs.existsSync(path.join('data', name, 'candidate.db')));
    return { bsize: 4096n, blocks: 2097152n, bavail: 262144n + (allocated ? 256n : 16384n) };
  };
  try {
    await assert.rejects(restoreDatabase(input), error => error.restorePreflight && error.status === 507);
    assertOriginal(original);
  } finally { fs.statfsSync = real; if (prior) process.env.EPILYKOS_MAINTENANCE_LOCK = prior; else delete process.env.EPILYKOS_MAINTENANCE_LOCK; }
});

test('cancellation interrupts a native migration and reaps it before staging cleanup', async () => {
  const original = live();
  const input = candidate('slow-migration.db', core + `CREATE TRIGGER slow_init AFTER INSERT ON config BEGIN
    SELECT sum(x) FROM (WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT x FROM n);
    END;`);
  const controller = new AbortController();
  let reachedMigration = false;
  const timer = setInterval(() => {
    if (fs.readdirSync('data').some(name => name.startsWith('.restore-') && fs.existsSync(path.join('data', name, 'candidate.db')))) {
      reachedMigration = true; controller.abort(new Error('cancel migration'));
    }
  }, 10);
  const deadline = setTimeout(() => controller.abort(new Error('preparation did not start')), 3000);
  const started = Date.now();
  try {
    await assert.rejects(require('../modules/restorePreparation').prepareRestore(input, original, database.DB_PATH, { signal: controller.signal }), /cancel migration/);
    assert.equal(reachedMigration, true); assert.ok(Date.now() - started < 2000);
    assertOriginal(original);
  } finally { clearInterval(timer); clearTimeout(deadline); }
});

test('staging cleanup failure cannot report a successful replacement as a failed rollback', async () => {
  live(); const input = candidate('cleanup.db');
  const remove = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (path.basename(file).startsWith('.restore-')) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    return remove(file, options);
  };
  try {
    assert.equal((await restoreDatabase(input)).success, true);
    assert.equal(database.getConfig('restore_probe'), 'candidate');
  } finally {
    fs.rmSync = remove;
    for (const name of fs.readdirSync('data').filter(name => name.startsWith('.restore-'))) remove(path.join('data', name), { recursive: true, force: true });
  }
});
