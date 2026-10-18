'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
process.env.LOG_TO_FILE = 'false';
const { createRestoreStaging, reapRestoreStaging, removeRestoreStagingMetadata } = require('../modules/restoreStaging');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-staging-ownership-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const fresh = () => fs.mkdtempSync(path.join(root, 'data-'));

test('private staging publishes ownership before writes and cleans normally', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), job = await createRestoreStaging(dir);
  assert.equal(fs.statSync(job.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(job.directory, 'owner.json')).mode & 0o777, 0o600);
  assert.equal(fs.fstatSync(job.leaseFd).isFile(), true);
  fs.writeFileSync(path.join(job.directory, 'candidate.db'), 'candidate');
  job.cleanup(); assert.equal(fs.existsSync(job.directory), false);
});

test('age does not make a live owner eligible for reaping', async () => {
  const dir = fresh(), job = await createRestoreStaging(dir);
  fs.writeFileSync(path.join(job.directory, 'candidate.db'), 'active copy');
  fs.utimesSync(job.directory, 1, 1);
  assert.deepEqual(await reapRestoreStaging(dir), []);
  assert.equal(fs.readFileSync(path.join(job.directory, 'candidate.db'), 'utf8'), 'active copy');
  job.cleanup();
});

test('released orphan is reaped including known SQLite scratch, without touching live data', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), job = await createRestoreStaging(dir);
  fs.writeFileSync(path.join(dir, 'energy.db'), 'live');
  fs.writeFileSync(path.join(job.directory, 'candidate.db'), 'abandoned');
  fs.mkdirSync(path.join(job.directory, 'scratch')); fs.writeFileSync(path.join(job.directory, 'scratch', 'etilqs_fixture'), 'sort');
  job.release();
  assert.deepEqual(await reapRestoreStaging(dir), [path.basename(job.directory)]);
  assert.equal(fs.existsSync(job.directory), false);
  assert.equal(fs.readFileSync(path.join(dir, 'energy.db'), 'utf8'), 'live');
});

test('journal ownership and unknown job contents prevent orphan deletion', async () => {
  const dir = fresh(), journaled = await createRestoreStaging(dir), unknown = await createRestoreStaging(dir);
  fs.writeFileSync(path.join(journaled.directory, 'original.db'), 'sole rollback');
  fs.writeFileSync(path.join(dir, '.restore-transaction.json'), JSON.stringify({ schema: 1, phase: 'pending', job: path.basename(journaled.directory), oldInode: '1', newInode: '2' }));
  fs.writeFileSync(path.join(unknown.directory, 'unrecognized.db'), 'preserve');
  journaled.release(); unknown.release();
  assert.deepEqual(await reapRestoreStaging(dir), []);
  assert.equal(fs.readFileSync(path.join(journaled.directory, 'original.db'), 'utf8'), 'sole rollback');
  assert.equal(fs.readFileSync(path.join(unknown.directory, 'unrecognized.db'), 'utf8'), 'preserve');
});

test('a native-worker lease remains live after the staging parent is killed', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const dir = fresh();
  const script = `
    const {spawn}=require('node:child_process'); const fs=require('node:fs');
    (async()=>{const job=await require(process.argv[1]).createRestoreStaging(process.argv[2]);
      const code="require('node:fs').writeFileSync(process.argv[1]+'/candidate.db','worker'); process.send('ready'); process.on('disconnect',()=>{}); setInterval(()=>{},1000)";
      const child=spawn(process.execPath,['-e',code,job.directory],{stdio:['ignore','ignore','ignore','ipc',job.leaseFd]});
      child.once('message',()=>process.send({directory:job.directory,pid:child.pid}));
      setInterval(()=>{},1000);
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  const parent = spawn(process.execPath, ['-e', script, require.resolve('../modules/restoreStaging'), dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let output = ''; parent.stderr.on('data', b => { output += b; }); let worker;
  try {
    const owner = await new Promise((resolve, reject) => { parent.once('message', resolve); parent.once('exit', code => reject(new Error('parent exited ' + code + ': ' + output))); });
    worker = owner.pid; const exited = new Promise(r => parent.once('exit', r)); parent.kill('SIGKILL'); await exited;
    assert.deepEqual(await reapRestoreStaging(dir), []);
    assert.equal(fs.readFileSync(path.join(owner.directory, 'candidate.db'), 'utf8'), 'worker');
    process.kill(worker, 'SIGKILL'); worker = null;
    const deadline = Date.now() + 5000; let removed = [];
    while (Date.now() < deadline && !removed.length) { removed = await reapRestoreStaging(dir); if (!removed.length) await new Promise(r => setTimeout(r, 20)); }
    assert.deepEqual(removed, [path.basename(owner.directory)]);
  } finally { parent.kill('SIGKILL'); if (worker) { try { process.kill(worker, 'SIGKILL'); } catch (_) {} } }
});

test('missing lease identity is uncertain and must not be recreated to justify deletion', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), job = await createRestoreStaging(dir);
  fs.writeFileSync(path.join(job.directory, 'candidate.db'), 'preserve uncertain owner'); job.release();
  fs.unlinkSync(path.join(job.directory, '.owner-lock'));
  assert.deepEqual(await reapRestoreStaging(dir), []);
  assert.equal(fs.readFileSync(path.join(job.directory, 'candidate.db'), 'utf8'), 'preserve uncertain owner');
});

for (const stage of ['.owner-lock', 'owner.json']) test('confirmation cleanup recovers after death following ' + stage + ' removal', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), job = await createRestoreStaging(dir), live = path.join(dir, 'energy.db'), candidate = path.join(job.directory, 'candidate.db');
  fs.writeFileSync(live, 'original'); fs.writeFileSync(candidate, 'candidate'); job.release();
  const script = `
    const fs=require('node:fs'),path=require('node:path'); const original=fs.unlinkSync;
    fs.unlinkSync=function(file){const result=original.call(this,file);if(path.basename(file)===process.argv[4])process.kill(process.pid,'SIGKILL');return result};
    const tx=require(process.argv[1]).beginRestoreSwap(process.argv[2],process.argv[3]);tx.commit();
  `;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../modules/restoreTransaction'), live, candidate, stage], { stdio: ['ignore', 'ignore', 'pipe'] });
  let output = ''; child.stderr.on('data', b => { output += b; }); const result = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(result.signal, 'SIGKILL', output);
  const recovered = require('../modules/restoreTransaction').recoverRestore(live);
  assert.equal(recovered.outcome, 'confirmed'); assert.equal(fs.readFileSync(live, 'utf8'), 'candidate');
  assert.equal(fs.existsSync(job.directory), false);
  assert.equal(fs.existsSync(path.join(dir, '.restore-transaction.json')), false);
});

for (const stage of ['candidate.db', '.owner-lock', 'owner.json']) test('orphan cleanup resumes after death following ' + stage + ' deletion', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), job = await createRestoreStaging(dir);
  fs.writeFileSync(path.join(job.directory, 'candidate.db'), 'abandoned candidate'); job.release();
  const script = `
    const fs=require('node:fs'),path=require('node:path'),unlink=fs.unlinkSync;
    fs.unlinkSync=function(file){const out=unlink.call(this,file);if(path.basename(file)===process.argv[3])process.kill(process.pid,'SIGKILL');return out};
    require(process.argv[1]).reapRestoreStaging(process.argv[2]).catch(e=>{console.error(e);process.exit(1)});
  `;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../modules/restoreStaging'), dir, stage], { stdio: ['ignore', 'ignore', 'pipe'] });
  let output = ''; child.stderr.on('data', b => { output += b; }); const result = await new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  assert.equal(result.signal, 'SIGKILL', output);
  if (stage === 'owner.json') assert.equal(fs.existsSync(path.join(job.directory, 'candidate.db')), false);
  assert.deepEqual(await reapRestoreStaging(dir), [path.basename(job.directory)]);
  assert.equal(fs.existsSync(job.directory), false);
});

for (const required of [true, false]) test('missing flock ' + (required ? 'refuses managed staging' : 'retains generic compatibility without automatic reaping'), { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh();
  const script = `(async()=>{try{const job=await require(process.argv[1]).createRestoreStaging(process.argv[2],{requireLease:process.argv[3]==='true'});process.send({ok:true,directory:job.directory,fd:job.leaseFd});job.release()}catch(e){process.send({ok:false,status:e.status})}process.disconnect()})()`;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../modules/restoreStaging'), dir, String(required)], { env: { ...process.env, PATH: '/fixture/no-flock', LOG_TO_FILE: 'false' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const result = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  await new Promise(r => child.once('close', r));
  if (required) { assert.equal(result.ok, false); assert.equal(result.status, 503); assert.deepEqual(fs.readdirSync(dir), []); }
  else { assert.equal(result.ok, true); assert.equal(result.fd, undefined); assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'owner.json'), 'utf8')).leased, false); assert.deepEqual(await reapRestoreStaging(dir), []); }
});

test('automatic cleanup waits for maintenance and can be stopped cleanly', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), job = await createRestoreStaging(dir); fs.writeFileSync(path.join(job.directory, 'candidate.db'), 'abandoned'); job.release();
  const release = await require('../modules/maintenanceLock').acquireLock('maintenance');
  let stop;
  try {
    stop = require('../modules/restoreStaging').startRestoreStagingCleanup(dir);
    await new Promise(r => setTimeout(r, 30)); assert.equal(fs.existsSync(job.directory), true);
  } finally { release(); }
  try {
    const deadline = Date.now() + 3000;
    while (fs.existsSync(job.directory) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(fs.existsSync(job.directory), false);
  } finally { await stop?.(); }
});

test('a native worker retains managed maintenance exclusion after its parent dies', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const dir = fresh(), lock = path.join(dir, 'host-maintenance.lock');
  const script = `
    const {spawn}=require('node:child_process');
    (async()=>{const release=await require(process.argv[1]).acquireLock('maintenance');const job=await require(process.argv[2]).createRestoreStaging(process.argv[3]);
      const child=spawn(process.execPath,['-e',"process.send('ready');process.on('disconnect',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc',job.leaseFd,release.leaseFd]});
      child.once('message',()=>process.send({pid:child.pid}));setInterval(()=>{},1000);
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  const parent = spawn(process.execPath, ['-e', script, require.resolve('../modules/maintenanceLock'), require.resolve('../modules/restoreStaging'), dir], { env: { ...process.env, EPILYKOS_MAINTENANCE_LOCK: lock }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let worker, output = ''; parent.stderr.on('data', b => { output += b; });
  const { acquireFileLease } = require('../modules/maintenanceFileLock');
  try {
    const ready = await new Promise((resolve, reject) => { parent.once('message', resolve); parent.once('exit', code => reject(new Error('parent exit ' + code + ': ' + output))); });
    worker = ready.pid; const exited = new Promise(r => parent.once('exit', r)); parent.kill('SIGKILL'); await exited;
    let probe;
    try { probe = await acquireFileLease(lock, 0); }
    catch (error) { assert.equal(error.code, 'LOCK_BUSY'); }
    if (probe) { probe.release(); assert.fail('managed maintenance became available while the native worker was still alive'); }
    process.kill(worker, 'SIGKILL'); worker = null;
    const deadline = Date.now() + 5000;
    for (;;) {
      try { probe = await acquireFileLease(lock, 0); probe.release(); break; }
      catch (error) { if (Date.now() >= deadline) throw error; await new Promise(r => setTimeout(r, 20)); }
    }
  } finally { parent.kill('SIGKILL'); if (worker) { try { process.kill(worker, 'SIGKILL'); } catch (_) {} } }
});

test('an incomplete but parseable journal blocks all automatic orphan decisions', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), orphan = await createRestoreStaging(dir); fs.writeFileSync(path.join(orphan.directory, 'candidate.db'), 'preserve while recovery is uncertain'); orphan.release();
  fs.writeFileSync(path.join(dir, '.restore-transaction.json'), JSON.stringify({ job: '.restore-ABCDEF' }));
  assert.deepEqual(await reapRestoreStaging(dir), []);
  assert.equal(fs.readFileSync(path.join(orphan.directory, 'candidate.db'), 'utf8'), 'preserve while recovery is uncertain');
});

for (const kind of ['directory', 'symlink', 'hardlink', 'unknown-file']) test('unknown scratch ' + kind + ' preserves all staging artifacts', { skip: process.platform !== 'linux' }, async () => {
  const dir = fresh(), job = await createRestoreStaging(dir), scratch = path.join(job.directory, 'scratch');
  fs.mkdirSync(scratch); fs.writeFileSync(path.join(scratch, 'etilqs_known'), 'SQLite scratch');
  fs.writeFileSync(path.join(job.directory, 'candidate.db'), 'candidate');
  const unknown = path.join(scratch, kind === 'unknown-file' ? 'original.db' : 'etilqs_unexpected');
  const outside = path.join(dir, 'original.db'); fs.writeFileSync(outside, 'preserve');
  if (kind === 'directory') { fs.mkdirSync(unknown); fs.writeFileSync(path.join(unknown, 'original.db'), 'preserve'); }
  else if (kind === 'symlink') fs.symlinkSync(outside, unknown);
  else if (kind === 'hardlink') fs.linkSync(outside, unknown);
  else fs.writeFileSync(unknown, 'preserve');
  try {
    assert.throws(() => removeRestoreStagingMetadata(job.directory), /scratch/);
    for (const file of ['owner.json', '.owner-lock', 'candidate.db', 'scratch/etilqs_known']) assert.equal(fs.existsSync(path.join(job.directory, file)), true, file);
  } finally { job.release(); }
  assert.deepEqual(await reapRestoreStaging(dir), []);
  assert.equal(fs.lstatSync(unknown).isDirectory(), kind === 'directory');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(path.join(job.directory, 'candidate.db'), 'utf8'), 'candidate');
});
