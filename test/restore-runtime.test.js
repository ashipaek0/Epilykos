'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-runtime-'));
const cwd = process.cwd(); process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.ENC_KEY_FILE = path.join(root, 'key');
const database = require('../modules/database');
const { restoreDatabase } = require('../modules/backup');
function fixture() {
  try { database.getDb().close(); } catch (_) {}
  fs.rmSync('data', { recursive: true, force: true });
  database.initializeDatabase(); database.setConfig('restore_probe', 'original');
  const input = path.join(root, 'input-' + Math.random() + '.db');
  const db = new Database(input);
  db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric));
    CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);
    INSERT INTO config VALUES('restore_probe','candidate');`);
  db.close(); return input;
}
after(() => { try { database.getDb().close(); } catch (_) {} process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });

test('runtime health participates before confirmation and failed health resumes the original', async () => {
  const input = fixture(), seen = [];
  await assert.rejects(restoreDatabase(input, { lifecycle: {
    pause() { seen.push('pause ' + database.getConfig('restore_probe')); },
    resume() {
      const value = database.getConfig('restore_probe'); seen.push('resume ' + value);
      if (value === 'candidate') throw new Error('runtime failed local health');
    }
  } }), /original database restored/);
  assert.deepEqual(seen, ['pause original', 'resume candidate', 'pause candidate', 'resume original']);
  assert.equal(database.getConfig('restore_probe'), 'original');
  assert.equal(fs.existsSync(path.join('data', '.restore-transaction.json')), false);
});

test('successful runtime rebinding happens while rollback assets and maintenance lease remain', async () => {
  const input = fixture(); let checked = false;
  const result = await restoreDatabase(input, { lifecycle: {
    resume() {
      checked = true;
      const journal = JSON.parse(fs.readFileSync(path.join('data', '.restore-transaction.json'), 'utf8'));
      assert.equal(journal.phase, 'pending');
      assert.equal(fs.existsSync(path.join('data', journal.job, 'original.db')), true);
      assert.equal(database.getConfig('restore_probe'), 'candidate');
    }
  } });
  assert.equal(result.success, true); assert.equal(checked, true);
});

test('retired async work cannot queue metrics or write config into the selected database', async () => {
  const input = fixture(), work = require('../modules/databaseWork');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = work.run(async () => {
    await gate;
    database.queueMetricWrite({ metric: 'retired', value: 7, timestamp: 1700000000 });
    assert.throws(() => database.setConfig('late config', 'must not appear'), error => error.code === 'DB_RETIRED');
  });
  await restoreDatabase(input); release(); await pending;
  database.flushMetrics();
  assert.equal(database.getDb().prepare('SELECT COUNT(*) AS n FROM metrics WHERE metric=?').get('retired').n, 0);
  assert.equal(database.getConfig('late config'), '');
  work.run(() => database.queueMetricWrite({ metric: 'current', value: 8, timestamp: 1700000000 }));
  database.flushMetrics();
  assert.equal(database.getDb().prepare('SELECT value FROM metrics WHERE metric=?').get('current').value, 8);
});

test('failed candidate work is retired on rollback and only the restore request is refreshed', async () => {
  const input = fixture(), work = require('../modules/databaseWork');
  let release, candidateWork; const gate = new Promise(resolve => { release = resolve; });
  await work.run(async () => {
    await assert.rejects(restoreDatabase(input, { lifecycle: {
      resume() {
        if (database.getConfig('restore_probe') === 'candidate') {
          candidateWork = (async () => { await gate; database.queueMetricWrite({ metric: 'failed candidate', value: 9 }); })();
          throw new Error('candidate runtime failure');
        }
      }
    } }));
    database.setConfig('restore request finalization', 'allowed');
  });
  release(); await candidateWork; database.flushMetrics();
  assert.equal(database.getConfig('restore_probe'), 'original');
  assert.equal(database.getConfig('restore request finalization'), 'allowed');
  assert.equal(database.getDb().prepare('SELECT COUNT(*) AS n FROM metrics WHERE metric=?').get('failed candidate').n, 0);
});

test('failed original-runtime resumption is recovery-required rather than falsely healthy', async () => {
  const input = fixture(), original = database.getDb();
  await assert.rejects(restoreDatabase(input, { lifecycle: {
    pause() { throw new Error('cannot flush runtime'); },
    resume() { throw new Error('cannot restart original runtime'); }
  } }), error => error.restoreRecoveryRequired === true && error.status === 503);
  assert.equal(original.open, true); // the pre-swap failure never replaced live storage
  assert.equal(fs.existsSync(path.join('data', '.restore-transaction.json')), false);
});

test('a retired main poll cycle stops after outstanding I/O and emits no replacement events', async () => {
  const input = fixture(), work = require('../modules/databaseWork'), { PollingManager } = require('../services/PollingManager');
  let release, started, extra = 0, events = 0;
  const gate = new Promise(r => { release = r; }), waiting = new Promise(r => { started = r; });
  const manager = new PollingManager([{ id: 'restore-first', async pollFn() { started(); await gate; } }, { id: 'restore-second', pollFn() { extra++; } }]);
  manager.on('metrics-ready', () => { events++; }); manager.on('device-error', () => { events++; });
  const pending = work.run(() => manager.runCycle()); await waiting;
  await restoreDatabase(input); release(); await pending;
  assert.equal(extra, 0); assert.equal(events, 0);
});

test('durable upload observation runs before live closure and authorization copy before confirmation', async () => {
  const input = fixture(), original = database.getDb(), seen = [];
  await restoreDatabase(input, {
    beforeActivate({ liveFile, preparedFile }) { assert.equal(original.open, true); assert.equal(fs.existsSync(liveFile), true); assert.equal(fs.existsSync(preparedFile), true); seen.push('before'); },
    afterActivate() { assert.equal(database.getConfig('restore_probe'), 'candidate'); assert.equal(JSON.parse(fs.readFileSync('data/.restore-transaction.json')).phase, 'pending'); seen.push('after'); }
  });
  assert.deepEqual(seen, ['before', 'after']);
});
