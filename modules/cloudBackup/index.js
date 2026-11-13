'use strict';
/**
 * Off-box backup: sends an encrypted copy of the newest daily snapshot to a
 * destination (a folder today; Google Drive and WebDAV later), weekly by
 * default, and keeps the newest N copies.
 *
 *   settings   config row `cloud_backup` (the passphrase is a SECRET_FIELDS leaf,
 *              locked with this box's key like other saved passwords)
 *   status     config row `cloud_backup_status` (last upload, failures, retry)
 *
 * A run: pick the newest verified snapshot (taking a fresh one for "Back up
 * now"), lock it with the passphrase while streaming it to the destination,
 * read it back to confirm it matches, and only then delete older copies, so a
 * failed upload never leaves nothing behind.
 *
 * All outside effects (config, snapshots, events, restore, clock) are passed
 * in, so the service is tested without a server.
 *
 * @module cloudBackup
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const envelope = require('./envelope');
const { createFolderDestination } = require('./destinations/folder');

const CONFIG_KEY = 'cloud_backup';
const STATUS_KEY = 'cloud_backup_status';
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const INTERVALS = { weekly: 7 * DAY, daily: DAY };
const RETRY = [30 * MINUTE, 2 * HOUR, 6 * HOUR, DAY];
const QUIET_FROM = 1, QUIET_TO = 6;           // scheduled uploads start between 01:00 and 06:00 local time
const WARN_EVERY = 6 * HOUR;
const FRESH_SNAPSHOT_MS = 36 * HOUR;

const DEFAULTS = { enabled: false, destination: { type: 'folder', path: '' }, schedule: 'weekly', keep: 1, passphrase: '' };

function problem(message, code, status = 422) { return Object.assign(new Error(message), { code, status, cloudBackup: true }); }

function backupName(now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `epilykos-backup-${stamp}-${crypto.randomBytes(3).toString('hex')}.epkb`;
}
const timeOfName = name => { const m = /(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(name); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : 0; };

function createCloudBackup({
  getConfig, setConfig, latestSnapshot, snapshotNow, dataDir, emit = () => {}, restore, readSpace,
  now = Date.now, makeDestination, logger = { info() {}, warn() {} }
}) {
  const destinationFor = makeDestination || (settings => {
    if (!settings || settings.type !== 'folder') throw problem('Choose where to send the backup.', 'DESTINATION_REQUIRED', 400);
    return createFolderDestination(settings, { dataDir });
  });

  let running = null, phase = 'idle', timer = null;

  function readJson(key, fallback) {
    try { const raw = getConfig(key); return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback }; } catch (_) { return { ...fallback }; }
  }
  const settings = () => { const s = readJson(CONFIG_KEY, DEFAULTS); s.destination = { ...DEFAULTS.destination, ...(s.destination || {}) }; return s; };
  const state = () => readJson(STATUS_KEY, { lastOkAt: null, lastAt: null, lastName: null, lastBytes: null, lastError: null, attempts: 0, retryAt: 0, warnAt: 0, overdueWarnAt: 0, enabledAt: null, dueNow: false });
  const saveState = s => setConfig(STATUS_KEY, JSON.stringify(s));

  function publicSettings(s = settings()) {
    return { enabled: Boolean(s.enabled), destination: { type: s.destination.type, path: s.destination.path || '' },
      schedule: s.schedule, keep: s.keep, hasPassphrase: Boolean(s.passphrase) };
  }

  /** Checks what the person sent. Returns the settings to store; throws a message they can act on. */
  function normalise(input, current) {
    const next = { ...current, destination: { ...current.destination } };
    if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
    if (input.schedule !== undefined) {
      if (!INTERVALS[input.schedule]) throw problem('Choose weekly or daily.', 'BAD_SCHEDULE', 400);
      next.schedule = input.schedule;
    }
    if (input.keep !== undefined) {
      const keep = Number(input.keep);
      if (!Number.isInteger(keep) || keep < 1 || keep > 8) throw problem('Copies to keep must be a whole number from 1 to 8.', 'BAD_KEEP', 400);
      next.keep = keep;
    }
    if (input.destination !== undefined) {
      const d = input.destination || {};
      if (d.type !== 'folder') throw problem('That destination is not available yet.', 'BAD_DESTINATION', 400);
      next.destination = { type: 'folder', path: typeof d.path === 'string' ? d.path.trim() : '' };
    }
    if (input.passphrase !== undefined && input.passphrase !== '') next.passphrase = envelope.normalisePassphrase(input.passphrase);
    if (next.enabled) {
      destinationFor(next.destination);   // throws for a missing or invalid destination
      if (!next.passphrase) throw problem('Enter a passphrase. You need it to restore, and it cannot be recovered.', 'PASSPHRASE_REQUIRED', 400);
    }
    return next;
  }

  function saveSettings(input) {
    if (running) throw problem('A backup is running. Wait for it to finish, then save again.', 'BUSY', 409);
    const before = settings();
    const next = normalise(input || {}, before);
    const changed = next.enabled !== before.enabled || JSON.stringify(next.destination) !== JSON.stringify(before.destination)
      || next.passphrase !== before.passphrase || next.schedule !== before.schedule;
    setConfig(CONFIG_KEY, JSON.stringify(next));
    const s = state();
    if (next.enabled && (!before.enabled || changed)) { s.enabledAt = s.enabledAt && before.enabled ? s.enabledAt : now(); s.dueNow = true; s.retryAt = 0; s.attempts = 0; s.lastError = null; saveState(s); }
    if (!next.enabled) { s.dueNow = false; saveState(s); }
    return publicSettings(next);
  }

  async function test(input) {
    const current = settings();
    const dest = destinationFor(input && input.destination ? { type: 'folder', path: String(input.destination.path || '').trim() } : current.destination);
    return dest.test();
  }

  function interval(s = settings()) { return INTERVALS[s.schedule] || INTERVALS.weekly; }

  function nextAt(s = settings(), st = state()) {
    if (!s.enabled) return null;
    if (st.dueNow) return Math.max(st.retryAt || 0, 0) || now();
    const base = st.lastOkAt ? st.lastOkAt + interval(s) : (st.enabledAt || now());
    return Math.max(base, st.retryAt || 0);
  }

  function isDue(t = now()) {
    const s = settings(), st = state();
    if (!s.enabled || !s.passphrase) return false;
    if (t < (st.retryAt || 0)) return false;
    if (st.dueNow || !st.lastOkAt) return true;
    const base = st.lastOkAt + interval(s);
    if (t < base) return false;
    if (t - base >= DAY) return true;
    const hour = new Date(t).getHours();
    return hour >= QUIET_FROM && hour < QUIET_TO;
  }

  function isOverdue(t = now()) {
    const s = settings(), st = state();
    if (!s.enabled) return false;
    return t - (st.lastOkAt || st.enabledAt || t) > interval(s) + 2 * DAY;
  }

  function status() {
    const s = settings(), st = state();
    return {
      enabled: Boolean(s.enabled), running: Boolean(running), phase,
      destination: s.destination.type === 'folder' ? { type: 'folder', label: s.destination.path } : { type: s.destination.type, label: '' },
      schedule: s.schedule, keep: s.keep,
      lastOkAt: st.lastOkAt ? new Date(st.lastOkAt).toISOString() : null,
      lastAttemptAt: st.lastAt ? new Date(st.lastAt).toISOString() : null,
      lastName: st.lastName, lastBytes: st.lastBytes, lastError: st.lastError, attempts: st.attempts,
      nextAt: nextAt(s, st) ? new Date(nextAt(s, st)).toISOString() : null,
      overdue: isOverdue()
    };
  }

  async function stream(dest, snapshot, name, passphrase) {
    const locker = await envelope.createLocker(passphrase);
    const tail = new PassThrough();
    const pump = pipeline(fs.createReadStream(snapshot.path), locker, tail);
    const [, result] = await Promise.all([pump, dest.put(name, tail)]);
    return result;
  }

  async function prune(dest, keep, justWritten) {
    const copies = (await dest.list()).filter(c => c.name !== justWritten).sort((a, b) => b.name.localeCompare(a.name));
    for (const old of copies.slice(Math.max(0, keep - 1))) await dest.remove(old.name);
  }

  async function execute({ manual }) {
    const s = settings();
    if (!s.passphrase) throw problem('Enter a passphrase first.', 'PASSPHRASE_REQUIRED', 400);
    const dest = destinationFor(s.destination);
    phase = 'checking the destination';
    await dest.test();
    await dest.cleanPartial();
    phase = 'preparing a snapshot';
    let snapshot = latestSnapshot();
    if (manual || !snapshot || now() - snapshot.time > FRESH_SNAPSHOT_MS) snapshot = await snapshotNow();
    if (!snapshot) throw problem('There is no snapshot to send yet.', 'NO_SNAPSHOT');
    const size = fs.statSync(snapshot.path).size;
    const name = backupName(now());
    phase = 'uploading';
    const sent = await stream(dest, snapshot, name, s.passphrase);
    if (sent.bytes !== envelope.lockedSize(size)) throw problem('The snapshot changed while it was being sent. Try again.', 'CHANGED');
    phase = 'checking the copy';
    await dest.verify(name, sent);
    phase = 'removing older copies';
    await prune(dest, s.keep, name);
    return { name, bytes: sent.bytes };
  }

  /** Runs one backup now. Only one runs at a time. */
  function run({ manual = false } = {}) {
    if (running) return running;
    const started = now();
    running = (async () => {
      try {
        const result = await execute({ manual });
        const st = state();
        Object.assign(st, { lastOkAt: now(), lastAt: started, lastName: result.name, lastBytes: result.bytes, lastError: null, attempts: 0, retryAt: 0, dueNow: false });
        saveState(st);
        logger.info('Cloud backup: uploaded ' + result.name);
        return { ok: true, ...result };
      } catch (error) {
        const st = state();
        const message = String(error && error.message || error).slice(0, 300);
        st.attempts = (st.attempts || 0) + 1; st.lastAt = started; st.lastError = message;
        st.retryAt = now() + RETRY[Math.min(st.attempts, RETRY.length) - 1];
        if (!st.warnAt || now() - st.warnAt >= WARN_EVERY) {
          st.warnAt = now();
          try { emit('backup.cloud_failed', { message }); } catch (_) {}
        }
        saveState(st);
        logger.warn('Cloud backup failed: ' + message);
        return { ok: false, error: message };
      } finally { running = null; phase = 'idle'; }
    })();
    return running;
  }

  async function tick() {
    if (running) return;
    const s = settings();
    if (!s.enabled) return;
    if (isOverdue()) {
      const st = state();
      if (!st.overdueWarnAt || now() - st.overdueWarnAt >= DAY) {
        st.overdueWarnAt = now(); saveState(st);
        try { emit('backup.cloud_overdue', { message: 'No off-box backup has been sent for more than ' + Math.round(interval(s) / DAY + 2) + ' days.' }); } catch (_) {}
      }
    }
    if (isDue()) await run({ manual: false });
  }

  function start({ every = 15 * MINUTE } = {}) {
    if (timer) return;
    timer = setInterval(() => { tick().catch(error => logger.warn('Cloud backup tick failed: ' + error.message)); }, every);
    timer.unref();
    setTimeout(() => tick().catch(() => {}), 60 * 1000).unref();
  }
  function stop() { clearInterval(timer); timer = null; }

  // ── The copies at the destination ──────────────────────────────────
  async function listCopies() {
    const s = settings();
    if (!s.destination.path && s.destination.type === 'folder') return [];
    const copies = await destinationFor(s.destination).list();
    return copies.map(c => ({ name: c.name, size: c.size, time: new Date(timeOfName(c.name)).toISOString() }))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async function readStart(dest, name, size) {
    const wanted = envelope.HEADER_BYTES + envelope.FRAME_BYTES;
    const chunks = []; let have = 0;
    const source = dest.get(name);
    try {
      for await (const chunk of source) { chunks.push(chunk); have += chunk.length; if (have >= wanted) break; }
    } finally { source.destroy(); }
    return Buffer.concat(chunks).subarray(0, wanted);
  }

  /** Confirms a copy opens with the passphrase and starts with an intact block. Does not restore anything. */
  async function checkCopy(name, { passphrase } = {}) {
    const s = settings();
    const secret = passphrase || s.passphrase;
    if (!secret) throw problem('Enter the passphrase for this copy.', 'PASSPHRASE_REQUIRED', 400);
    const dest = destinationFor(s.destination);
    const copy = (await dest.list()).find(c => c.name === name);
    if (!copy) throw problem('That copy is no longer at the destination.', 'NOT_FOUND', 404);
    await envelope.checkStart(secret, await readStart(dest, name, copy.size), copy.size);
    return { ok: true, size: copy.size };
  }

  /** Downloads a copy, unlocks it and hands it to the normal restore. */
  async function restoreCopy(name, { passphrase, restoreOptions = {} } = {}) {
    if (running) throw problem('A backup is running. Wait for it to finish, then restore.', 'BUSY', 409);
    const s = settings();
    const secret = passphrase || s.passphrase;
    if (!secret) throw problem('Enter the passphrase for this copy.', 'PASSPHRASE_REQUIRED', 400);
    const dest = destinationFor(s.destination);
    const copy = (await dest.list()).find(c => c.name === name);
    if (!copy) throw problem('That copy is no longer at the destination.', 'NOT_FOUND', 404);
    if (readSpace) {
      const space = readSpace(dataDir);
      if (space && space.available && space.available_bytes < copy.size * 3) throw problem('Not enough free space on this box to download that copy.', 'NO_SPACE', 507);
    }
    const work = fs.mkdtempSync(path.join(dataDir, '.cloud-restore-'));
    try {
      fs.chmodSync(work, 0o700);
      const file = path.join(work, 'download.db.gz');
      await pipeline(dest.get(name), await envelope.createUnlocker(secret), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      return await restore(file, restoreOptions);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    }
  }

  return { settings: publicSettings, rawSettings: settings, saveSettings, test, status, run, tick, start, stop, isDue, isOverdue,
    listCopies, checkCopy, restoreCopy, CONFIG_KEY, STATUS_KEY };
}

module.exports = { createCloudBackup, CONFIG_KEY, STATUS_KEY, backupName, timeOfName };
