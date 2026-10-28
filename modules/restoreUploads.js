'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb, DB_PATH } = require('./database');
const databaseWork = require('./databaseWork');
const { acquireLock } = require('./maintenanceLock');
const { createRestoreStaging, reapRestoreStaging } = require('./restoreStaging');
const { restoreUploadAdmission } = require('./restorePreflight');
const { restoreDatabase } = require('./backup');
const { logger } = require('./logger');
const backupSecrets = require('./backupSecrets');
const CHUNK_BYTES = 4 * 1024 * 1024;
const PHASES = new Set(['uploading', 'passphrase', 'preparing', 'activating', 'recovering', 'selected', 'recovered', 'failed', 'cancelled', 'unknown']);
function problem(status, message) { return Object.assign(new Error(message), { status }); }
function sync(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function identity(file) { const info = fs.statSync(file, { bigint: true }); return { dev: info.dev.toString(), ino: info.ino.toString() }; }
function same(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }

function createRestoreUploadManager({ directory = path.dirname(DB_PATH), liveFile = DB_PATH, lifecycle = {},
  captureSession = () => null, restoreSession = () => {}, onFatal = () => {},
  idleMs = 60000, passphraseMs = 5 * 60000, restore = restoreDatabase } = {}) {
  directory = path.resolve(directory); liveFile = path.resolve(liveFile);
  const statusFile = path.join(directory, '.restore-upload-status.json');
  let active = null, last = null, closed = false;
  function persist(record) {
    const bytes = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(bytes) > 8192) throw new Error('Restore status is too large');
    const temporary = statusFile + '.tmp';
    // This fixed small file has one main-thread writer; no native worker writes
    // status. Reject aliases rather than truncating a substituted path.
    try {
      const info = fs.lstatSync(temporary);
      if (!info.isFile() || info.nlink !== 1 || info.size > 8192) throw new Error('Unknown restore status temporary file');
      fs.unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    sync(temporary); fs.renameSync(temporary, statusFile);
    if (process.platform !== 'win32') sync(directory);
  }
  function update(job, phase, extra = {}) {
    Object.assign(job.record, extra, { phase, updatedAt: new Date().toISOString() });
    last = job.record; persist(last);
  }
  function publicStatus(record) {
    if (!record) return null;
    const { id, phase, bytes, received, name, createdAt, updatedAt, error } = record;
    return { id, phase, bytes, received, name, createdAt, updatedAt, error, chunkBytes: CHUNK_BYTES };
  }
  try {
    const info = fs.lstatSync(statusFile);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8192) throw new Error('Unknown restore status file');
    const record = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (record.schema !== 1 || !/^[0-9a-f-]{36}$/.test(record.id) || !PHASES.has(record.phase)
        || !Number.isSafeInteger(record.bytes) || !Number.isSafeInteger(record.received)
        || record.bytes < 1 || record.received < 0 || record.received > record.bytes
        || (record.name !== undefined && (typeof record.name !== 'string' || record.name.length > 160))) throw new Error('Invalid restore status');
    last = record;
    if (['activating', 'recovering'].includes(record.phase)) {
      const selected = identity(liveFile);
      record.phase = same(selected, record.prepared) ? 'selected' : same(selected, record.original) ? 'recovered' : 'unknown';
      record.error = record.phase === 'unknown' ? 'Selected database identity could not be matched; inspect restore recovery before retrying.' : undefined;
      record.updatedAt = new Date().toISOString(); persist(record);
    } else if (['uploading', 'passphrase', 'preparing'].includes(record.phase)) {
      record.phase = 'failed'; record.error = 'Restore was interrupted before activation. The original database was retained.';
      record.updatedAt = new Date().toISOString(); persist(record);
    }
  } catch (error) { if (error.code !== 'ENOENT') logger.warn('Restore upload status unavailable: ' + error.message); }

  function find(id) {
    if (!last || (id !== undefined && id !== last.id)) throw problem(404, 'Restore upload was not found');
    return last;
  }
  function finish(job, phase, error) {
    if (job.finished) return;
    job.finished = true; clearTimeout(job.timer);
    try { update(job, phase, { error: error ? String(error.message || error).slice(0, 512) : undefined }); }
    catch (failure) { logger.warn('Restore result persistence failed: ' + failure.message); }
    finally {
      try { job.staging.cleanup(); } catch (failure) { logger.warn('Restore upload cleanup deferred: ' + failure.message); }
      job.release(); if (active === job) active = null;
    }
  }
  function armIdle(job, ms = idleMs) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => { cancel(job.record.id).catch(error => logger.warn('Restore expiry: ' + error.message)); }, ms);
    job.timer.unref();
  }
  // A backup made with a passphrase waits here, after the upload, for the
  // person to give it (or to restore without the saved passwords). The
  // passphrase lives only in this closure: never in the status file.
  function askPassphrase(job, marker) {
    return new Promise((resolve, reject) => {
      job.waiting = { marker, resolve, reject, checking: false };
      job.controller.signal.addEventListener('abort', () => reject(job.controller.signal.reason), { once: true });
      update(job, 'passphrase', { error: undefined });
      armIdle(job, passphraseMs);
    });
  }
  async function passphrase(id, { passphrase: text, skip } = {}) {
    const record = find(id), job = active, waiting = job && job.record === record ? job.waiting : null;
    if (!waiting || record.phase !== 'passphrase') throw problem(409, 'This restore is not waiting for a passphrase');
    if (waiting.checking) throw problem(409, 'The passphrase is already being checked');
    let value = null;
    if (skip !== true) {
      waiting.checking = true;
      try { await backupSecrets.verify(waiting.marker, text); value = text; }
      catch (error) {
        armIdle(job, passphraseMs);
        if (error.code === 'PASSPHRASE_WRONG') update(job, 'passphrase', { error: error.message });
        throw error.status ? error : problem(400, error.message);
      } finally { waiting.checking = false; }
    }
    job.waiting = null; clearTimeout(job.timer);
    update(job, 'preparing', { error: undefined });
    waiting.resolve(value);
    return publicStatus(job.record);
  }
  async function create({ bytes, name, sessionId } = {}) {
    if (closed) throw problem(503, 'Restore uploads are stopping');
    if (active) throw problem(409, 'A restore upload is already active');
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw problem(400, 'Invalid restore upload size');
    const reservation = {}; active = reservation;
    let release, staging;
    try {
      release = await acquireLock('maintenance', { timeoutMs: 5000 });
      if (closed) throw problem(503, 'Restore uploads are stopping');
      await reapRestoreStaging(directory);
      restoreUploadAdmission(getDb(), directory, bytes);
      staging = await createRestoreStaging(directory, { role: 'restore-upload' });
      const file = path.join(staging.directory, 'input.db');
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      const now = new Date().toISOString();
      const job = { staging, release, file, sessionId, controller: new AbortController(), record: {
        schema: 1, id: randomUUID(), phase: 'uploading', bytes, received: 0,
        name: typeof name === 'string' ? path.basename(name).slice(0, 160) : 'backup.db', createdAt: now, updatedAt: now
      } };
      update(job, 'uploading'); active = job; armIdle(job); return publicStatus(job.record);
    } catch (error) {
      try { staging?.cleanup(); } finally { release?.(); if (active === reservation) active = null; }
      throw error;
    }
  }
  async function prepare(job) {
    let savedSession;
    try {
      await restore(job.file, {
        lifecycle, signal: job.controller.signal, maintenanceLease: job.release,
        leaseFds: job.staging.leaseFd === undefined ? [] : [job.staging.leaseFd],
        askPassphrase: marker => askPassphrase(job, marker),
        beforeActivate({ liveFile: live, preparedFile }) {
          job.controller.signal.throwIfAborted();
          savedSession = captureSession(job.sessionId);
          // Failure here is before any live close/rename. Status is observational
          // only; the existing durable restore journal owns file recovery.
          update(job, 'activating', { original: identity(live), prepared: identity(preparedFile) });
        },
        afterActivate() { restoreSession(savedSession); }
      });
      finish(job, 'selected');
    } catch (error) {
      finish(job, error.restoreRecoveryRequired ? 'recovering' : job.controller.signal.aborted ? 'cancelled' : 'failed', error);
      if (error.restoreRecoveryRequired) onFatal(error);
    }
  }
  async function receiveChunk(job, stream, length) {
    const expected = Math.min(CHUNK_BYTES, job.record.bytes - job.record.received), offset = job.record.received;
    let handle, count = 0;
    const abort = () => stream.destroy(job.controller.signal.reason);
    try {
      if (length !== undefined && length !== expected) throw problem(400, 'Incorrect restore chunk length');
      handle = await fs.promises.open(job.file, 'r+');
      job.controller.signal.addEventListener('abort', abort, { once: true });
      job.controller.signal.throwIfAborted(); armIdle(job);
      for await (const chunk of stream) {
        job.controller.signal.throwIfAborted();
        if (count + chunk.length > expected) throw problem(400, 'Restore chunk exceeds its declared length');
        restoreUploadAdmission(getDb(), directory, job.record.bytes, offset + count);
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written, offset + count + written);
          if (!result.bytesWritten) throw new Error('Restore upload write made no progress');
          written += result.bytesWritten;
        }
        count += chunk.length; armIdle(job);
      }
      if (count !== expected) throw problem(400, 'Restore chunk ended before its declared length');
      job.controller.signal.throwIfAborted();
      await handle.sync(); await handle.close(); handle = null;
      update(job, 'uploading', { received: offset + count });
      if (job.record.received === job.record.bytes) {
        clearTimeout(job.timer); update(job, 'preparing');
        job.preparation = databaseWork.run(() => prepare(job));
      } else armIdle(job);
      return publicStatus(job.record);
    } catch (error) {
      if (handle) { await handle.close(); handle = null; }
      finish(job, job.controller.signal.aborted ? 'cancelled' : 'failed', error);
      throw error;
    } finally { job.controller.signal.removeEventListener('abort', abort); if (handle) await handle.close(); job.busy = false; }
  }
  function receive(id, offset, stream, length) {
    const record = find(id), job = active;
    if (!job || job.record !== record || record.phase !== 'uploading' || job.busy) return Promise.reject(problem(409, 'Restore upload is not ready for a chunk'));
    if (!Number.isSafeInteger(offset) || offset !== record.received) return Promise.reject(problem(409, 'Restore chunk offset does not match accepted bytes'));
    job.busy = true; job.chunk = receiveChunk(job, stream, length); return job.chunk;
  }
  async function cancel(id) {
    const record = find(id), job = active;
    if (!job || job.record !== record) return publicStatus(record);
    if (record.phase === 'activating') throw problem(409, 'Restore activation is already in progress');
    job.controller.abort(problem(400, 'Restore upload cancelled'));
    await job.chunk?.catch(() => {}); await job.preparation;
    finish(job, 'cancelled'); return publicStatus(job.record);
  }
  return {
    create, receive, cancel, passphrase,
    status(id) { return id === undefined && !last ? null : publicStatus(find(id)); },
    capacity() { return { ...restoreUploadAdmission(getDb(), directory, null), chunkBytes: CHUNK_BYTES }; },
    async close() { closed = true; if (active?.record) await cancel(active.record.id); }
  };
}
module.exports = { createRestoreUploadManager, CHUNK_BYTES };
