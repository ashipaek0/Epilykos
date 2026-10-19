'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip, createGunzip } = require('node:zlib');
const { createBackupSnapshot } = require('./sqliteSnapshot');
const { gzipLimit, StorageAdmissionError } = require('./snapshotBudget');
const { createRestoreStaging, reapRestoreStaging } = require('./restoreStaging');
const { readSpace } = require('./storageStatus');
const host = require('./hostActions');
const { logger } = require('./logger');
const MODERN = /^energy-snapshot-g([0-9]{20})-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)-[0-9a-f-]{36}\.db\.gz$/;
const LEGACY = /^energy-snapshot-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.db$/;
function sync(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDir(dir) { if (process.platform !== 'win32') sync(dir); }
function getSnapshots(directory) {
  let names; try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const name of names) {
    const modern = MODERN.exec(name);
    if (!modern && !name.endsWith('.db')) continue;
    const file = path.join(directory, name); let info;
    try { info = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.nlink > (modern ? 2 : 1) || (modern && info.size < 18)) continue;
    found.push({ name, path: file, time: info.mtimeMs, size: info.size, format: modern ? 'gzip' : 'sqlite',
      generation: modern ? BigInt(modern[1]) : 0n, managed: Boolean(modern || LEGACY.test(name)) });
  }
  return found.sort((a,b) => a.generation === b.generation ? b.time - a.time || a.name.localeCompare(b.name) : a.generation > b.generation ? -1 : 1);
}
function requireSpace(directory, bytes) {
  const space = readSpace(directory), appliance = Boolean(process.env.EPILYKOS_MAINTENANCE_LOCK) || host.available();
  if (!space.available || space.available_bytes - (appliance ? space.maintenance_floor_bytes : 0) < bytes) throw new StorageAdmissionError('Not enough DATA space for compressed snapshot output and scratch');
}
async function createCompressedSnapshot(db, snapshots, { directory = path.dirname(snapshots), signal, leaseFds = [], now = Date.now, onPhase = () => {} } = {}) {
  directory = path.resolve(directory); snapshots = path.resolve(snapshots);
  signal?.throwIfAborted();
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(snapshots).isDirectory()) throw new Error('Snapshot directory must be a real directory');
  syncDir(path.dirname(snapshots));
  await reapRestoreStaging(directory, { signal });
  const prior = getSnapshots(snapshots).filter(s => s.managed);
  const generation = (prior[0]?.generation || 0n) + 1n;
  if (generation.toString().length > 20) throw new Error('Snapshot generation exhausted');
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `energy-snapshot-g${String(generation).padStart(20,'0')}-${stamp}-${randomUUID()}.db.gz`, published = path.join(snapshots, name);
  const job = await createRestoreStaging(directory, { role: 'snapshot-capture' });
  try {
    const raw = path.join(job.directory, 'snapshot.db'), compressed = raw + '.gz', scratch = path.join(job.directory, 'scratch');
    fs.mkdirSync(scratch, { mode: 0o700 });
    await createBackupSnapshot(db, raw, { signal, compressed: true, scratch, leaseFds: [...leaseFds, ...(job.leaseFd === undefined ? [] : [job.leaseFd])] });
    fs.chmodSync(raw, 0o600); onPhase('captured');
    const original = fs.statSync(raw), maximum = gzipLimit(original.size), guard = 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maximum)) throw new StorageAdmissionError('Snapshot allocation is too large');
    const hash = createHash('sha256'); let bytes = 0, compressedBytes = 0;
    requireSpace(directory, maximum + guard);
    await pipeline(fs.createReadStream(raw), new Transform({ transform(chunk, _, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); } }), createGzip(),
      new Transform({ transform(chunk, _, done) {
        try {
          compressedBytes += chunk.length;
          if (compressedBytes > maximum) throw new StorageAdmissionError('Compressed snapshot exceeded its output allowance');
          const written = fs.existsSync(compressed) ? fs.statSync(compressed).size : 0;
          requireSpace(directory, Math.max(0, maximum - written) + guard); done(null, chunk);
        } catch (error) { done(error); }
      } }), fs.createWriteStream(compressed, { flags: 'wx', mode: 0o600 }), { signal });
    const sha256 = hash.digest('hex'); onPhase('compressed');
    const verify = createHash('sha256'); let verified = 0;
    await pipeline(fs.createReadStream(compressed), createGunzip(), new Writable({ write(chunk, _, done) {
      try {
        verified += chunk.length;
        if (verified > bytes) throw new Error('Compressed snapshot expands beyond its source size');
        requireSpace(directory, guard); verify.update(chunk); done();
      } catch (error) { done(error); }
    } }), { signal });
    const after = fs.statSync(raw);
    if (bytes !== original.size || verified !== bytes || verify.digest('hex') !== sha256 || after.dev !== original.dev || after.ino !== original.ino || after.size !== original.size || after.mtimeMs !== original.mtimeMs) throw new Error('Compressed snapshot verification does not match its validated source');
    signal?.throwIfAborted(); sync(raw); sync(compressed); onPhase('verified');
    fs.linkSync(compressed, published); onPhase('linked');
    syncDir(snapshots); onPhase('durable');
    fs.unlinkSync(compressed); syncDir(job.directory); onPhase('detached');
    // Only a verified, durable replacement authorizes pruning. Unknown files
    // are never counted as successful managed retention or removed here.
    for (const old of getSnapshots(snapshots).filter(s => s.managed).slice(2)) {
      fs.unlinkSync(old.path); syncDir(snapshots); onPhase('pruned');
    }
    return { name, path: published, sha256, bytes, size: compressedBytes };
  } finally {
    try { job.cleanup(); } catch (error) { logger.warn('Snapshot staging cleanup deferred: ' + error.message); }
  }
}
module.exports = { createCompressedSnapshot, getSnapshots };
