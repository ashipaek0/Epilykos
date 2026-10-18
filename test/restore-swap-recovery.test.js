'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const transaction = require('../modules/restoreTransaction');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-swap-recovery-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const schema = value => `CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);
  CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric));
  CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);
  INSERT INTO config VALUES('restore_probe','${value}');`;
function fixture() {
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const job = path.join(directory, '.restore-ABC123'); fs.mkdirSync(job, { mode: 0o700 });
  const live = path.join(directory, 'energy.db'), candidate = path.join(job, 'candidate.db');
  for (const [file, value] of [[live, 'original'], [candidate, 'candidate']]) {
    const db = new Database(file); db.exec(schema(value)); db.close();
  }
  return { directory, job, live, candidate, journal: path.join(directory, '.restore-transaction.json') };
}
const killer = `
  const fs=require('node:fs'), path=require('node:path'), Database=require(process.argv[2]);
  const {beginRestoreSwap}=require(process.argv[3]);
  const directory=process.argv[1], stage=process.argv[4];
  const live=path.join(directory,'energy.db'), job=path.join(directory,'.restore-ABC123');
  const journal=path.join(directory,'.restore-transaction.json');
  function kill(at){ if(stage===at) process.kill(process.pid,'SIGKILL'); }
  const write=fs.writeFileSync, rename=fs.renameSync, unlink=fs.unlinkSync, rmdir=fs.rmdirSync;
  fs.writeFileSync=(file,data,...args)=>{
    let phase=path.basename(file).startsWith('.restore-journal-')?JSON.parse(data).phase:null;
    if(phase)kill('before_'+phase+'_write'); const result=write(file,data,...args);
    if(phase)kill('after_'+phase+'_write'); return result;
  };
  fs.renameSync=(from,to)=>{
    let phase=to===journal?JSON.parse(fs.readFileSync(from,'utf8')).phase:null;
    if(phase)kill('before_'+phase+'_publish');
    const result=rename(from,to);
    if(phase)kill('after_'+phase+'_publish');
    if(from===live)kill('after_old_move');
    if(from===path.join(job,'candidate.db'))kill('after_new_move');
    if(from===path.join(job,'original.db'))kill('after_rollback_move');
    return result;
  };
  fs.unlinkSync=file=>{
    const result=unlink(file);
    if(file===path.join(job,'original.db'))kill('after_original_delete');
    if(file===journal){ kill('after_journal_delete'); if(stage.startsWith('after_rollback'))kill('after_rollback_journal_delete'); }
    return result;
  };
  fs.rmdirSync=file=>{const result=rmdir(file); if(file===job){ kill('after_job_delete'); if(stage.startsWith('after_rollback'))kill('after_rollback_job_delete'); } return result;};
  const swap=beginRestoreSwap(live,path.join(job,'candidate.db'));
  const db=new Database(live); db.pragma('journal_mode=WAL');
  db.prepare('INSERT INTO config VALUES(?,?)').run('candidate_wal_probe','kept');
  kill('after_candidate_write');
  if(stage.startsWith('after_rollback')){ db.close(); swap.rollback(); }
  else { swap.commit(); kill('after_commit'); db.close(); }
`;
const stages = [
  ['before_pending_write', 'original'], ['after_pending_write', 'original'],
  ['before_pending_publish', 'original'], ['after_pending_publish', 'original'],
  ['after_old_move', 'original'], ['after_new_move', 'original'],
  ['after_candidate_write', 'original'], ['before_confirmed_write', 'original'],
  ['after_confirmed_write', 'original'], ['before_confirmed_publish', 'original'],
  ['after_confirmed_publish', 'candidate'], ['after_original_delete', 'candidate'],
  ['after_job_delete', 'candidate'], ['after_journal_delete', 'candidate'],
  ['after_commit', 'candidate'], ['after_rollback_move', 'original'],
  ['after_rollback_job_delete', 'original'], ['after_rollback_journal_delete', 'original']
];
for (const [stage, expected] of stages) {
  test('process death at ' + stage + ' recovers ' + expected + ' without unrelated WAL', () => {
    const f = fixture();
    const child = spawnSync(process.execPath, ['-e', killer, f.directory, require.resolve('better-sqlite3'), require.resolve('../modules/restoreTransaction'), stage], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    transaction.recoverRestore(f.live);
    const db = new Database(f.live, { fileMustExist: true });
    try {
      assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
      assert.equal(db.prepare("SELECT value FROM config WHERE key='restore_probe'").get().value, expected);
      const row = db.prepare("SELECT value FROM config WHERE key='candidate_wal_probe'").get();
      assert.equal(row?.value, expected === 'candidate' ? 'kept' : undefined);
    } finally { db.close(); }
    assert.equal(fs.existsSync(f.journal), false);
    // Recovery is idempotent and cannot replay a completed transaction.
    assert.deepEqual(transaction.recoverRestore(f.live), { recovered: false });
  });
}

test('impossible pending state fails before startup can create an empty database', () => {
  const f = fixture(); transaction.beginRestoreSwap(f.live, f.candidate);
  fs.unlinkSync(path.join(f.job, 'original.db')); fs.unlinkSync(f.live);
  const startup = fs.mkdtempSync(path.join(root, 'startup-'));
  fs.renameSync(f.directory, path.join(startup, 'data'));
  const live = path.join(startup, 'data', 'energy.db');
  const child = spawnSync(process.execPath, ['-e', `
    process.env.LOG_TO_FILE='false'; process.chdir(process.argv[1]);
    require(process.argv[2]).initializeDatabase();
  `, startup, require.resolve('../modules/database')], { encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /No complete original/);
  assert.throws(() => transaction.recoverRestore(live), /No complete original/);
  assert.equal(fs.existsSync(live), false);
  assert.equal(fs.existsSync(path.join(startup, 'data', '.restore-transaction.json')), true);
});

test('malformed or traversing journals preserve all files and fail closed', () => {
  for (const contents of ['{broken', JSON.stringify({ schema: 1, phase: 'pending', job: '../escape', oldInode: '1', newInode: '2' })]) {
    const f = fixture(); const before = fs.readFileSync(f.live);
    fs.writeFileSync(f.journal, contents);
    assert.throws(() => transaction.recoverRestore(f.live));
    assert.deepEqual(fs.readFileSync(f.live), before);
    assert.equal(fs.existsSync(f.candidate), true);
  }
});

test('unknown active inode or original sidecar is preserved for recovery diagnosis', () => {
  for (const corrupt of ['inode', 'sidecar']) {
    const f = fixture(); transaction.beginRestoreSwap(f.live, f.candidate);
    if (corrupt === 'inode') {
      // Allocate while the candidate still exists: unlink/recreate can reuse
      // its inode, so it would no longer exercise the unknown-inode branch.
      const unrelated = path.join(f.directory, 'unrelated');
      fs.writeFileSync(unrelated, 'unrelated replacement');
      assert.notEqual(fs.statSync(unrelated, { bigint: true }).ino, fs.statSync(f.live, { bigint: true }).ino);
      fs.renameSync(unrelated, f.live);
    }
    else fs.writeFileSync(path.join(f.job, 'original.db-wal'), 'do not delete');
    assert.throws(() => transaction.recoverRestore(f.live));
    assert.equal(fs.existsSync(path.join(f.job, 'original.db')), true);
    assert.equal(fs.existsSync(f.journal), true);
  }
});

test('confirmation directory-sync failure can durably revert intent before rollback', () => {
  const f = fixture(), swap = transaction.beginRestoreSwap(f.live, f.candidate);
  const rename = fs.renameSync, sync = fs.fsyncSync;
  let confirmed = false;
  fs.renameSync = (from, to) => {
    const phase = to === f.journal ? JSON.parse(fs.readFileSync(from, 'utf8')).phase : '';
    const result = rename(from, to);
    if (phase === 'confirmed') confirmed = true;
    return result;
  };
  fs.fsyncSync = fd => {
    if (confirmed && fs.readlinkSync('/proc/self/fd/' + fd) === f.directory) {
      confirmed = false; throw Object.assign(new Error('confirmation sync failed'), { code: 'EIO' });
    }
    return sync(fd);
  };
  try { assert.throws(() => swap.commit(), /confirmation sync failed/); }
  finally { fs.renameSync = rename; fs.fsyncSync = sync; }
  swap.rollback();
  const db = new Database(f.live);
  try { assert.equal(db.prepare("SELECT value FROM config WHERE key='restore_probe'").get().value, 'original'); }
  finally { db.close(); }
  assert.equal(fs.existsSync(f.journal), false);
});

test('pending intent with original already live refuses an unrelated WAL untouched', () => {
  const f = fixture();
  fs.writeFileSync(f.journal, JSON.stringify({ schema: 1, phase: 'pending', job: path.basename(f.job),
    oldInode: fs.statSync(f.live).ino.toString(), newInode: fs.statSync(f.candidate).ino.toString() }));
  const otherFile = path.join(f.directory, 'unrelated.db'); fs.copyFileSync(f.live, otherFile);
  const other = new Database(otherFile); other.pragma('journal_mode=WAL'); other.pragma('wal_autocheckpoint=0');
  other.prepare("UPDATE config SET value='unrelated WAL data' WHERE key='restore_probe'").run();
  try {
    fs.copyFileSync(otherFile + '-wal', f.live + '-wal');
    const before = fs.readFileSync(f.live + '-wal');
    assert.throws(() => transaction.recoverRestore(f.live), /standalone/);
    assert.equal(fs.existsSync(f.journal), true);
    assert.deepEqual(fs.readFileSync(f.live + '-wal'), before);
  } finally { other.close(); }
});

test('pending intent with no live DB preserves sidecars that have no candidate owner', () => {
  const f = fixture(); transaction.beginRestoreSwap(f.live, f.candidate);
  fs.renameSync(f.live, f.candidate);
  fs.writeFileSync(f.live + '-wal', 'unowned WAL');
  assert.throws(() => transaction.recoverRestore(f.live), /standalone/);
  assert.equal(fs.readFileSync(f.live + '-wal', 'utf8'), 'unowned WAL');
  assert.equal(fs.existsSync(f.live), false);
  assert.equal(fs.existsSync(path.join(f.job, 'original.db')), true);
  assert.equal(fs.existsSync(f.journal), true);
});
