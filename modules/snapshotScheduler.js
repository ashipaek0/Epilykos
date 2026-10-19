'use strict';
const fs = require('node:fs'), path = require('node:path');
const DAY = 24 * 60 * 60 * 1000, MINUTE = 60000;
const DELAYS = [5 * MINUTE, 30 * MINUTE, 2 * 60 * MINUTE];
function sync(file) { const fd = fs.openSync(file,'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function regular(file) {
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.nlink !== 1 || s.size > 4096) throw new Error('Unknown snapshot retry state file'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function valid(s) {
  return s?.schema === 1 && Number.isInteger(s.count) && s.count >= 0 && s.count <= 4
    && [s.windowAt,s.nextAt].every(n => Number.isSafeInteger(n) && n >= 0)
    && (s.lastAt === null || Number.isSafeInteger(s.lastAt) && s.lastAt >= 0)
    && (s.error === null || typeof s.error === 'string' && s.error.length <= 512)
    && (s.warnAt === null || Number.isSafeInteger(s.warnAt) && s.warnAt >= 0);
}
function createSnapshotScheduler({ stateFile, latest, healthy, acquire, run, warn = () => {}, wall = Date.now, monotonic = () => performance.now() }) {
  let state = { schema: 1, count: 0, windowAt: wall(), lastAt: null, nextAt: 0, error: null, warnAt: null };
  let stateError = null, phase = 'idle', running = null, closed = false, lastFailureWarning = -Infinity;
  const controller = new AbortController();
  function persist() {
    if (!valid(state)) throw new Error('Invalid snapshot retry state');
    regular(stateFile); const temporary = stateFile + '.tmp';
    if (regular(temporary)) fs.unlinkSync(temporary);
    fs.writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    sync(temporary); fs.renameSync(temporary, stateFile);
    if (process.platform !== 'win32') sync(path.dirname(stateFile));
  }
  try {
    if (regular(stateFile)) { const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!valid(loaded)) throw new Error('Invalid snapshot retry state'); state = loaded; }
    if (wall() < state.windowAt || state.lastAt !== null && wall() < state.lastAt) {
      state.windowAt = wall(); state.lastAt = state.lastAt === null ? null : wall();
      state.nextAt = state.count ? wall() + (DELAYS[state.count - 1] || DAY) : 0; persist();
    }
  } catch (error) { stateError = 'Automatic snapshot retry state unavailable: ' + error.message; phase = 'failed'; }
  let windowDeadline = monotonic() + Math.max(0, DAY - Math.max(0, wall() - state.windowAt));
  let retryDeadline = monotonic() + Math.max(0, Math.min(DAY, state.nextAt - wall()));
  function warning(type, message) { try { warn(type, message); } catch (_) {} }
  function failure(error) {
    phase = 'failed'; state.error = String(error.message || error).slice(0,512);
    if (monotonic() - lastFailureWarning >= 15 * MINUTE) { lastFailureWarning = monotonic(); warning('backup.snapshot_failed', state.error); }
  }
  function current() {
    const snapshot = latest(), age = snapshot ? wall() - snapshot.time : Infinity;
    return { snapshot, due: !snapshot || age < 0 || age >= DAY, overdue: !snapshot || age < 0 || age >= DAY + 60 * MINUTE };
  }
  function status() {
    let info; try { info = current(); } catch (_) { info = { snapshot: null, overdue: true }; }
    return { phase, attempts: state.count, error: stateError || state.error, overdue: info.overdue,
      latest: info.snapshot ? { name: info.snapshot.name, time: new Date(info.snapshot.time).toISOString() } : null,
      lastAttemptAt: state.lastAt === null ? null : new Date(state.lastAt).toISOString(),
      nextAttemptAt: state.count ? new Date(wall() + Math.max(0, Math.max(retryDeadline, state.count >= 4 ? windowDeadline : 0) - monotonic())).toISOString() : null };
  }
  async function attempt() {
    if (stateError) { failure(new Error(stateError)); return; }
    const info = current();
    if (!info.due) { phase = 'ready'; return; }
    if (monotonic() >= windowDeadline) {
      state.count = 0; state.windowAt = wall(); state.nextAt = 0; windowDeadline = monotonic() + DAY; retryDeadline = monotonic();
    }
    if (info.overdue && (state.warnAt === null || wall() < state.warnAt || wall() - state.warnAt >= DAY)) {
      state.warnAt = wall(); persist(); warning('backup.snapshot_overdue', info.snapshot ? 'The daily snapshot is overdue or its timestamp is ahead of the system clock.' : 'No automatic snapshot is available yet.');
    }
    if (state.count >= 4 || monotonic() < retryDeadline) { phase = 'retrying'; return; }
    if (!healthy()) { phase = 'waiting'; return; }
    let release;
    try { release = await acquire(); }
    catch (error) {
      if (error.code === 'LOCK_BUSY' || /^Maintenance lock 'maintenance' timed out after /.test(error.message)) phase = 'waiting';
      else failure(error);
      return; // maintenance busy is not a failed capture
    }
    try {
      controller.signal.throwIfAborted();
      if (!healthy()) { phase = 'waiting'; return; }
      state.count++; state.lastAt = wall(); state.error = null;
      retryDeadline = state.count >= 4 ? windowDeadline : monotonic() + DELAYS[state.count - 1];
      state.nextAt = wall() + Math.ceil(Math.max(0, retryDeadline - monotonic())); persist();
      phase = 'capturing';
      await run(release, controller.signal);
      state.count = 0; state.windowAt = wall(); state.nextAt = 0; state.error = null; state.warnAt = null;
      windowDeadline = monotonic() + DAY; retryDeadline = monotonic(); persist(); phase = 'ready';
    } catch (error) {
      if (!controller.signal.aborted) { failure(error); try { persist(); } catch (error) { stateError = 'Automatic snapshot retry state unavailable: ' + error.message; } }
    } finally { release(); }
  }
  function tick() {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = attempt().catch(failure).finally(() => { running = null; if (closed) phase = 'stopped'; }); return running;
  }
  return { tick, status, async stop() { closed = true; controller.abort(new Error('Snapshot scheduler stopped')); await running; phase = 'stopped'; } };
}
module.exports = { createSnapshotScheduler, DAY };
