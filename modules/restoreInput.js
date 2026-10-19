'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { restoreUploadAdmission } = require('./restorePreflight');
const { createRestoreStaging } = require('./restoreStaging');
const { logger } = require('./logger');
function invalid(message, status = 400) { return Object.assign(new Error(message), { status, restorePreflight: true }); }
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function same(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }

// No gzip footer/ratio is trusted as an expanded size. The compressed source is
// already allocated; fresh DATA admission counts expansion plus migration.
async function normalizeRestoreInput(source, db, liveFile, { signal } = {}) {
  signal?.throwIfAborted();
  const before = stat(source);
  if (!before?.isFile() || same(before, stat(liveFile))) throw invalid('Restore requires a separate regular backup file');
  const header = Buffer.alloc(2), fd = fs.openSync(source, 'r');
  try { fs.readSync(fd, header, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (header[0] !== 0x1f || header[1] !== 0x8b) return { filePath: source, format: 'sqlite', cleanup() {} };
  if (['-wal', '-shm', '-journal'].some(suffix => stat(source + suffix))) throw invalid('Gzip restore requires a self-contained archive without sidecars');
  const directory = path.dirname(liveFile);
  let job;
  const cleanup = () => {
    if (!job) return;
    try { job.cleanup(); } catch (error) { logger.warn('Restore expansion cleanup deferred: ' + error.message); }
  };
  try {
    job = await createRestoreStaging(directory, { role: 'restore-expand' });
    signal?.throwIfAborted();
    const maximum = restoreUploadAdmission(db, directory, null).maxBytes;
    if (!Number.isSafeInteger(maximum) || maximum < 512) throw invalid('Not enough usable DATA space to expand the gzip backup', 507);
    const destination = path.join(job.directory, 'expanded.db');
    let received = 0;
    const meter = new Transform({ transform(chunk, encoding, done) {
      try {
        signal?.throwIfAborted();
        const next = received + chunk.length;
        if (!Number.isSafeInteger(next) || next > maximum) throw invalid('Gzip backup exceeds its admitted expanded size', 507);
        // Count the prospective next raw size, not a speculative reservation
        // for an unused ceiling. Never credit deletion of retained/live files.
        restoreUploadAdmission(db, directory, next, Math.min(received, stat(destination)?.size || 0));
        received = next; done(null, chunk);
      } catch (error) { done(error); }
    } });
    await pipeline(fs.createReadStream(source), zlib.createGunzip(), meter,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    const after = stat(source);
    if (!same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw invalid('The gzip backup changed during expansion');
    if (received < 512) throw invalid('Expanded gzip backup is too small for SQLite');
    const output = fs.openSync(destination, 'r'); try { fs.fsyncSync(output); } finally { fs.closeSync(output); }
    return { filePath: destination, format: 'gzip', bytes: received, leaseFd: job.leaseFd, cleanup };
  } catch (error) {
    cleanup();
    if (signal?.aborted || error.restorePreflight) throw error;
    throw invalid('Gzip backup expansion failed: ' + error.message, error.code === 'ENOSPC' ? 507 : 400);
  }
}
module.exports = { normalizeRestoreInput };
