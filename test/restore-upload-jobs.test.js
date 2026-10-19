'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-upload-jobs-')), cwd = process.cwd();
process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.ENC_KEY_FILE = path.join(root, 'key');
const db = require('../modules/database');
const { createRestoreUploadManager, CHUNK_BYTES } = require('../modules/restoreUploads');
const { acquireLock } = require('../modules/maintenanceLock');
const { reapRestoreStaging } = require('../modules/restoreStaging');
function fixture(extra = false) {
  try { db.getDb().close(); } catch (_) {} fs.rmSync('data', { recursive: true, force: true }); db.initializeDatabase(); db.setConfig('upload_probe', 'original');
  const input = path.join(root, 'input-' + Math.random() + '.db'), candidate = new Database(input);
  candidate.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric)); CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER); INSERT INTO config VALUES('upload_probe','selected')`);
  if (extra) candidate.exec('CREATE TABLE opaque(payload BLOB); INSERT INTO opaque VALUES(zeroblob(4200000))');
  candidate.close(); return input;
}
async function terminal(manager, id) {
  const deadline = Date.now() + 15000;
  for (;;) { const status = manager.status(id); if (['selected', 'failed', 'cancelled', 'recovered', 'unknown'].includes(status.phase)) return status; if (Date.now() > deadline) throw new Error('upload did not finish'); await new Promise(r => setTimeout(r, 10)); }
}
after(() => { try { db.getDb().close(); } catch (_) {} process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });

test('sequential chunks stream into DATA and native restore continues independently of the request', async () => {
  const input = fixture(true), manager = createRestoreUploadManager(), size = fs.statSync(input).size;
  try {
    const job = await manager.create({ bytes: size, name: 'input.db' }); assert.equal(job.chunkBytes, CHUNK_BYTES);
    assert.match(fs.readdirSync('data').find(n => /^\.restore-upload-[A-Za-z0-9]{6}$/.test(n)), /^\.restore-upload-/);
    await assert.rejects(manager.create({ bytes: size }), error => error.status === 409);
    await assert.rejects(acquireLock('maintenance', { timeoutMs: 0 }), /timed out/);
    await assert.rejects(manager.receive(job.id, 1, Readable.from([])), error => error.status === 409);
    let offset = 0;
    while (offset < size) {
      const end = Math.min(offset + CHUNK_BYTES, size);
      await manager.receive(job.id, offset, fs.createReadStream(input, { start: offset, end: end - 1 }), end - offset);
      offset = end;
    }
    assert.equal((await terminal(manager, job.id)).phase, 'selected');
    assert.equal(db.getConfig('upload_probe'), 'selected');
    assert.equal(fs.readdirSync('data').some(n => /^\.restore-(upload-)?[A-Za-z0-9]{6}$/.test(n)), false);
    const restarted = createRestoreUploadManager(); assert.equal(restarted.status(job.id).phase, 'selected'); await restarted.close();
  } finally { await manager.close(); }
});

for (const bytes of [10, 513]) test('short or excessive chunk fails safely with ' + bytes + ' received bytes', async () => {
  fixture(); const manager = createRestoreUploadManager();
  try {
    const job = await manager.create({ bytes: 512 });
    await assert.rejects(manager.receive(job.id, 0, Readable.from([Buffer.alloc(bytes)])), error => error.status === 400);
    assert.equal(manager.status(job.id).phase, 'failed'); assert.equal(db.getConfig('upload_probe'), 'original');
    const release = await acquireLock('maintenance', { timeoutMs: 0 }); release();
    assert.equal(fs.readdirSync('data').some(n => /^\.restore-upload-[A-Za-z0-9]{6}$/.test(n)), false);
  } finally { await manager.close(); }
});

test('cancel preparation aborts and awaits its worker before releasing DATA ownership', async () => {
  const input = fixture(), size = fs.statSync(input).size; let entered, exited = false;
  const started = new Promise(r => { entered = r; });
  const manager = createRestoreUploadManager({ restore: async (_, options) => {
    entered(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    assert.deepEqual(await reapRestoreStaging('data'), []); exited = true; throw options.signal.reason;
  } });
  try {
    const job = await manager.create({ bytes: size }); await manager.receive(job.id, 0, fs.createReadStream(input), size); await started;
    await manager.cancel(job.id); assert.equal(exited, true); assert.equal(manager.status(job.id).phase, 'cancelled');
    const release = await acquireLock('maintenance', { timeoutMs: 0 }); release();
  } finally { await manager.close(); }
});

test('abandoned between-chunk upload expires and leaves original data available', async () => {
  fixture(); const manager = createRestoreUploadManager({ idleMs: 30 });
  try { const job = await manager.create({ bytes: 512 }); assert.equal((await terminal(manager, job.id)).phase, 'cancelled'); assert.equal(db.getConfig('upload_probe'), 'original'); }
  finally { await manager.close(); }
});

for (const outcome of ['selected', 'recovered', 'unknown']) test('startup status observes recovered inode identity: ' + outcome, async () => {
  fixture(); const manager = createRestoreUploadManager(), job = await manager.create({ bytes: 512 }); await manager.cancel(job.id); await manager.close();
  const file = path.join('data', '.restore-upload-status.json'), record = JSON.parse(fs.readFileSync(file)), info = fs.statSync('data/energy.db', { bigint: true });
  const actual = { dev: info.dev.toString(), ino: info.ino.toString() }, other = { dev: '0', ino: '0' };
  Object.assign(record, { phase: 'activating', original: outcome === 'recovered' ? actual : other, prepared: outcome === 'selected' ? actual : other }); fs.writeFileSync(file, JSON.stringify(record));
  const restarted = createRestoreUploadManager();
  try { assert.equal(restarted.status(job.id).phase, outcome); assert.equal(db.getConfig('upload_probe'), 'original'); }
  finally { await restarted.close(); }
});

for (const disconnect of [false, true]) test(disconnect ? 'disconnect during a partial chunk cleans DATA and preserves the original' : 'cancel interrupts a slow chunk without waiting for the idle deadline', async () => {
  fixture(); const manager = createRestoreUploadManager(), stream = new PassThrough();
  try {
    const job = await manager.create({ bytes: 512 });
    const receiving = assert.rejects(manager.receive(job.id, 0, stream, 512), /cancelled|disconnect/);
    stream.write(Buffer.alloc(10)); await new Promise(r => setTimeout(r, 20));
    if (disconnect) stream.destroy(new Error('uploader disconnected')); else await manager.cancel(job.id);
    await receiving; assert.equal(manager.status(job.id).phase, disconnect ? 'failed' : 'cancelled');
    assert.equal(db.getConfig('upload_probe'), 'original'); const release = await acquireLock('maintenance', { timeoutMs: 0 }); release();
    assert.equal(fs.readdirSync('data').some(n => /^\.restore-upload-[A-Za-z0-9]{6}$/.test(n)), false);
  } finally { await manager.close(); }
});
for (const stage of ['before', 'after']) test(stage + '-activation hook failure preserves the original database', async () => {
  const input = fixture(), size = fs.statSync(input).size;
  const manager = createRestoreUploadManager({
    captureSession() { if (stage === 'before') fs.mkdirSync('data/.restore-upload-status.json.tmp'); return {}; },
    restoreSession() { if (stage === 'after') throw new Error('authorization copy failed'); }
  });
  try {
    const job = await manager.create({ bytes: size }); await manager.receive(job.id, 0, fs.createReadStream(input), size);
    assert.equal((await terminal(manager, job.id)).phase, 'failed'); assert.equal(db.getConfig('upload_probe'), 'original');
    const release = await acquireLock('maintenance', { timeoutMs: 0 }); release();
  } finally { await manager.close(); }
});

test('small gzip input restores through the native preparation and swap path', async () => {
  const input = fixture(), compressed = require('node:zlib').gzipSync(fs.readFileSync(input));
  assert.ok(compressed.length < 512, 'fixture exercises sub512-byte declaration/status');
  const manager = createRestoreUploadManager();
  try {
    const job = await manager.create({ bytes: compressed.length, name: 'opaque.bin' });
    await manager.receive(job.id, 0, Readable.from([compressed]), compressed.length);
    assert.equal((await terminal(manager, job.id)).phase, 'selected'); assert.equal(db.getConfig('upload_probe'), 'selected');
    assert.equal(fs.readdirSync('data').some(n => /^\.restore-expand-[A-Za-z0-9]{6}$/.test(n)), false);
    const restarted = createRestoreUploadManager(); assert.equal(restarted.status(job.id).phase, 'selected'); await restarted.close();
  } finally { await manager.close(); }
});

for (const invalid of ['crc', 'sqlite']) test('bad gzip ' + invalid + ' keeps live SQLite unchanged', async () => {
  const input = fixture();
  const content = invalid === 'sqlite' ? Buffer.alloc(2048) : fs.readFileSync(input);
  const compressed = require('node:zlib').gzipSync(content); if (invalid === 'crc') compressed[compressed.length - 8] ^= 1;
  const manager = createRestoreUploadManager();
  try {
    const job = await manager.create({ bytes: compressed.length }); await manager.receive(job.id, 0, Readable.from([compressed]), compressed.length);
    assert.equal((await terminal(manager, job.id)).phase, 'failed'); assert.equal(db.getConfig('upload_probe'), 'original');
    assert.equal(fs.readdirSync('data').some(n => /^\.restore-expand-[A-Za-z0-9]{6}$/.test(n)), false);
  } finally { await manager.close(); }
});

test('snapshot catalogue restores both published gzip and legacy SQLite through the validated transaction',async()=>{
 const input=fixture(),snapshots=path.join(root,'data','snapshots');
 const gzip=await require('../modules/compressedSnapshots').createCompressedSnapshot(db.getDb(),snapshots,{directory:path.join(root,'data')});
 db.setConfig('upload_probe','changed-after-capture');
 await require('../modules/backup').restoreFromSnapshot(gzip.name);assert.equal(db.getConfig('upload_probe'),'original');
 const legacy='energy-snapshot-2020-01-01T00-00-00.db';fs.copyFileSync(input,path.join(snapshots,legacy));
 await require('../modules/backup').restoreFromSnapshot(legacy);assert.equal(db.getConfig('upload_probe'),'selected');
});
