'use strict';
/**
 * Free pages left by the retention rollup are given back to the disk:
 * - a new database is created in incremental auto-vacuum mode;
 * - an incremental database shrinks in batches, and one with little waste is left alone;
 * - an older database (auto_vacuum off) gets one full VACUUM that also switches it
 *   to incremental, but only when DATA has room to rewrite it;
 * - the restore upload refusal names the sizes involved.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-dbcompact-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const Database = require('better-sqlite3');
const database = require('../modules/database');
const { compactOnce, readStats } = require('../modules/dbCompact');
const { restoreUploadAdmission } = require('../modules/restorePreflight');
const SMALL = { minFreeBytes: 64 * 1024, minFreeRatio: 0.25 };

function filled(name, autoVacuum) {
  const file = path.join(tmp, name);
  const db = new Database(file);
  if (autoVacuum) db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE raw (id INTEGER PRIMARY KEY, payload TEXT)');
  const insert = db.prepare('INSERT INTO raw (payload) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < 4000; i++) insert.run('x'.repeat(900)); })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { db, file };
}
const size = file => fs.statSync(file).size;

test('a new database is created in incremental auto-vacuum mode', () => {
  database.initializeDatabase();
  assert.equal(database.getDb().pragma('auto_vacuum', { simple: true }), 2);
});

test('an incremental database gives back its free pages; little waste is left alone', async () => {
  const { db, file } = filled('inc.db', true);
  const full = size(file);
  assert.deepEqual(await compactOnce({ db, directory: tmp, ...SMALL }), { action: 'none' }, 'nothing deleted yet');
  db.prepare('DELETE FROM raw WHERE id % 10 != 0').run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(size(file), full, 'deleting alone does not shrink the file');
  const result = await compactOnce({ db, directory: tmp, ...SMALL });
  assert.equal(result.action, 'incremental');
  assert.ok(size(file) < full / 4, `file shrank: ${size(file)} of ${full}`);
  assert.equal(readStats(db).free, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw').get().n, 400, 'rows are untouched');
  assert.deepEqual(await compactOnce({ db, directory: tmp, ...SMALL }), { action: 'none' }, 'already compact');
  db.close();
});

test('an older database is vacuumed once, switched to incremental, and only with room to rewrite it', async () => {
  const { db, file } = filled('old.db', false);
  const full = size(file);
  db.prepare('DELETE FROM raw WHERE id % 10 != 0').run();
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 0);

  const original = fs.statfsSync;
  try {
    fs.statfsSync = () => ({ blocks: 100n, bavail: 1n, bsize: 1048576n });
    const skipped = await compactOnce({ db, directory: tmp, quiet: true, ...SMALL });
    assert.equal(skipped.action, 'skipped'); assert.equal(skipped.reason, 'space');
    assert.equal(db.pragma('auto_vacuum', { simple: true }), 0, 'nothing changed');
  } finally { fs.statfsSync = original; }
  assert.equal(size(file), full);

  fs.statfsSync = () => ({ blocks: 100000n, bavail: 90000n, bsize: 1048576n });
  try {
    const result = await compactOnce({ db, directory: tmp, ...SMALL });
    assert.equal(result.action, 'vacuum');
  } finally { fs.statfsSync = original; }
  assert.ok(size(file) < full / 4);
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw').get().n, 400);
  db.close();
});

test('the upload refusal says how big the file is and how much space it needs', () => {
  const original = fs.statfsSync;
  const GiB = 1024 ** 3;
  const db = { pragma(name) { return name === 'page_size' ? 4096 : 1000; } };
  fs.statfsSync = () => ({ blocks: BigInt(Math.round(25.6 * GiB)), bavail: BigInt(Math.round(22.1 * GiB)), bsize: 1n });
  const env = process.env.EPILYKOS_MAINTENANCE_LOCK;
  process.env.EPILYKOS_MAINTENANCE_LOCK = '/fixture/lock';
  try {
    assert.throws(() => restoreUploadAdmission(db, '.', Math.round(6.6 * GiB)), error => {
      assert.equal(error.status, 507);
      assert.match(error.message, /^Not enough usable DATA space for the upload/);
      assert.match(error.message, /6\.6 GiB backup needs about 19\.8 GiB free, 19\.\d GiB is usable/);
      assert.match(error.message, /compact the database/);
      return true;
    });
    assert.doesNotThrow(() => restoreUploadAdmission(db, '.', Math.round(5 * GiB)));
  } finally { fs.statfsSync = original; if (env === undefined) delete process.env.EPILYKOS_MAINTENANCE_LOCK; else process.env.EPILYKOS_MAINTENANCE_LOCK = env; }
});
