'use strict';
/**
 * Passphrase-protected saved passwords in a backup.
 *
 * A normal backup holds saved passwords and tokens (SECRET_FIELDS in
 * encryption.js) locked with the box's own key, which stays on the box, so a
 * restore onto another box cannot read them. With a passphrase, the backup's
 * copy of those secrets is locked with a key made from the passphrase
 * instead, so one file can be restored anywhere, and a leaked file is useless
 * without the passphrase.
 *
 *   backup   protect(file, passphrase)   on the private copy being sent
 *   restore  inspect(file) → marker      is this backup protected?
 *            verify(marker, passphrase)  is the passphrase right?
 *            unlock(file, passphrase)    on the prepared candidate: locked
 *                                        again with this box's key
 *
 * Format: a config row `backup_secrets_v1` = { v, kdf: 'scrypt', N, r, p,
 * salt, check } and each secret leaf as `$encp1$` + base64url(iv | tag |
 * ciphertext) (AES-256-GCM). `check` is a known text locked the same way, so
 * a wrong passphrase is told apart from a damaged file before anything else
 * is touched. The passphrase is normalised (NFKC) so it types the same on any
 * device, and is never stored or logged.
 *
 * @module backupSecrets
 */
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const { SECRET_FIELDS, isEncrypted, encryptString, decryptString } = require('./encryption');

const PREFIX = '$encp1$';
const MARKER_KEY = 'backup_secrets_v1';
const CHECK_TEXT = 'epilykos backup secrets v1';
const KDF = { N: 32768, r: 8, p: 1 };
const MIN_LENGTH = 8, MAX_LENGTH = 256;

function problem(message, code, status = 422) { return Object.assign(new Error(message), { code, status, restorePreflight: true }); }

function normalise(passphrase) {
  if (typeof passphrase !== 'string') throw problem('Enter a passphrase.', 'PASSPHRASE_INVALID', 400);
  const text = passphrase.normalize('NFKC');
  if (text.length < MIN_LENGTH) throw problem(`The passphrase needs at least ${MIN_LENGTH} characters.`, 'PASSPHRASE_INVALID', 400);
  if (text.length > MAX_LENGTH) throw problem(`The passphrase can be at most ${MAX_LENGTH} characters.`, 'PASSPHRASE_INVALID', 400);
  return text;
}

function deriveKey(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r }, (error, key) => error ? reject(error) : resolve(key));
  });
}

const b64 = buffer => Buffer.from(buffer).toString('base64url');

function lock(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + b64(Buffer.concat([iv, cipher.getAuthTag(), data]));
}

function open(key, envelope) {
  const raw = Buffer.from(String(envelope).slice(PREFIX.length), 'base64url');
  if (raw.length < 28) throw new Error('Damaged secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

const isProtected = value => typeof value === 'string' && value.startsWith(PREFIX);

// Every secret leaf of every config row that holds one: fn(value) → replacement.
// Scalars (fields: []) are the whole value; blobs are JSON with named leaves.
function mapSecrets(db, fn) {
  const read = db.prepare('SELECT key, value FROM config WHERE key = ?');
  const write = db.prepare('UPDATE config SET value = ? WHERE key = ?');
  let count = 0;
  db.transaction(() => {
    for (const [configKey, fields] of Object.entries(SECRET_FIELDS)) {
      const row = read.get(configKey);
      if (!row || typeof row.value !== 'string' || row.value === '') continue;
      if (fields.length === 0) {
        const next = fn(row.value);
        if (next !== row.value) { write.run(next, configKey); count++; }
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(row.value); } catch (_) { continue; }
      const wanted = new Set(fields.map(f => String(f).toLowerCase()));
      let changed = false;
      (function walk(node) {
        if (node === null || typeof node !== 'object') return;
        for (const k of Object.keys(node)) {
          const v = node[k];
          if (v !== null && typeof v === 'object') walk(v);
          else if (wanted.has(String(k).toLowerCase()) && typeof v === 'string' && v !== '') {
            const next = fn(v);
            if (next !== v) { node[k] = next; changed = true; count++; }
          }
        }
      })(parsed);
      if (changed) write.run(JSON.stringify(parsed), configKey);
    }
  })();
  return count;
}

function openFile(file, options) {
  return new Database(file, { fileMustExist: true, ...options });
}

/**
 * Lock the saved secrets in a private copy of the database with a key made
 * from `passphrase`. A secret this box cannot read (its own key changed)
 * has nothing to carry over and is left empty.
 */
async function protect(file, passphrase) {
  const text = normalise(passphrase);
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(text, salt, KDF);
  const db = openFile(file);
  try {
    const count = mapSecrets(db, value => {
      let plain;
      try { plain = isEncrypted(value) ? decryptString(value) : value; } catch (_) { return ''; }
      return plain === '' ? '' : lock(key, plain);
    });
    const marker = { v: 1, kdf: 'scrypt', ...KDF, salt: b64(salt), check: lock(key, CHECK_TEXT) };
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(MARKER_KEY, JSON.stringify(marker));
    // The copy goes out as one self-contained file.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    return { protected: count };
  } finally { db.close(); }
}

// Opening a WAL-mode file, even read-only, makes -wal and -shm beside it, and
// restore refuses a backup that has sidecars. Remove the ones made here. A
// file that already has sidecars is not opened at all: null, and the restore's
// own check refuses it with a clear message.
function withoutNewSidecars(file, work) {
  const suffixes = ['-wal', '-shm', '-journal'];
  const had = suffixes.filter(suffix => fs.existsSync(file + suffix));
  if (had.length) return null;
  try { return work(); } finally {
    for (const suffix of suffixes) if (!had.includes(suffix)) fs.rmSync(file + suffix, { force: true });
  }
}

/** The marker of a protected backup, or null for an ordinary one. */
function inspect(file) {
  return withoutNewSidecars(file, () => {
    const db = openFile(file, { readonly: true });
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(MARKER_KEY);
      if (!row) return null;
      let marker;
      try { marker = JSON.parse(row.value); } catch (_) { marker = null; }
      const sane = marker && marker.v === 1 && marker.kdf === 'scrypt'
        && marker.N === KDF.N && marker.r === KDF.r && marker.p === KDF.p
        && typeof marker.salt === 'string' && typeof marker.check === 'string' && isProtected(marker.check);
      if (!sane) throw problem('This backup is marked as passphrase-protected but its protection data is damaged.', 'BACKUP_SECRETS_DAMAGED', 400);
      return marker;
    } finally { db.close(); }
  });
}

async function keyFor(marker, passphrase) {
  const key = await deriveKey(normalise(passphrase), Buffer.from(marker.salt, 'base64url'), marker);
  try {
    if (open(key, marker.check) !== CHECK_TEXT) throw new Error('mismatch');
  } catch (_) { throw problem('That passphrase is not right.', 'PASSPHRASE_WRONG'); }
  return key;
}

/** Resolves when the passphrase opens the backup's check text; rejects with PASSPHRASE_WRONG. */
async function verify(marker, passphrase) { await keyFor(marker, passphrase); return true; }

/**
 * Lock the backup's secrets again with THIS box's key, in the prepared
 * candidate. A passphrase of `null` restores without the saved passwords:
 * they are emptied and have to be entered again. The marker row goes.
 */
async function unlock(file, marker, passphrase) {
  const key = passphrase === null ? null : await keyFor(marker, passphrase);
  const db = openFile(file);
  try {
    const count = mapSecrets(db, value => {
      if (!isProtected(value)) return value;
      if (key === null) return '';
      return encryptString(open(key, value));
    });
    db.prepare('DELETE FROM config WHERE key = ?').run(MARKER_KEY);
    db.pragma('wal_checkpoint(TRUNCATE)');
    return { unlocked: key === null ? 0 : count, emptied: key === null ? count : 0 };
  } finally { db.close(); }
}

module.exports = { protect, inspect, verify, unlock, normalise, MARKER_KEY, PREFIX, MIN_LENGTH, MAX_LENGTH };
