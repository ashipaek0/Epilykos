'use strict';
/**
 * Two-step sign-in: a 6-digit code from an authenticator app (TOTP, RFC 6238)
 * after the admin password, plus one-time recovery codes.
 *
 * State is one file, data/two-step.json, next to the password file, so the
 * physical-access password resets (BOOT file, console) can switch it off by
 * deleting it, and a database-only backup never carries it:
 *
 *   { v: 1, secret: '$enc1$…'  the base32 secret, encrypted like other secrets
 *     recovery_key: hex        keys the recovery-code hashes
 *     recovery: [hex, …]       HMAC-SHA256 of each unused code
 *     last_step: n             the newest 30 s step already accepted
 *     created: ISO }
 *
 * A TOTP step is accepted once, so a code that was seen cannot be replayed.
 * If the secret cannot be decrypted (the encryption key is gone) only a
 * recovery code signs in: the check fails closed, never open.
 *
 * RESET_TWO_STEP=true in the environment deletes the file at start (the
 * Docker equivalent of the physical resets).
 *
 * @module twoStep
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encryptString, decryptString } = require('./encryption');
const { logger } = require('./logger');

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW_STEPS = 1;            // one step either side: about a minute of clock drift
const RECOVERY_COUNT = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I, L, O, 0, 1

function stateFile() {
  return process.env.TWO_STEP_FILE || path.join(__dirname, '..', 'data', 'two-step.json');
}

// ── RFC 4648 base32 and RFC 4226/6238 ──────────────────────────────────
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

function stepAt(ms) { return Math.floor(ms / 1000 / STEP_SECONDS); }

/** The code for a moment (used by the tests and the setup check). */
function codeAt(secret, ms = Date.now()) { return hotp(base32Decode(secret), stepAt(ms)); }

/**
 * The accepted step for `code`, or null. A step at or before `lastStep` is
 * refused, so each code works once.
 */
function verifyTotp(secret, code, { now = Date.now(), lastStep = -1 } = {}) {
  const text = String(code == null ? '' : code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(text)) return null;
  const key = base32Decode(secret);
  const center = stepAt(now);
  let matched = null;
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset++) {
    const step = center + offset;
    const expected = Buffer.from(hotp(key, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(text)) && step > lastStep) matched = step;
  }
  return matched;
}

function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

function otpauthUri(secret, { issuer = 'Epilykos', account = 'dashboard' } = {}) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ── Recovery codes ─────────────────────────────────────────────────────
function normaliseRecovery(code) { return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function newRecoveryCode() {
  let out = '';
  for (const byte of crypto.randomBytes(10)) out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  return out.slice(0, 5) + '-' + out.slice(5);
}

function hashRecovery(keyHex, code) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(normaliseRecovery(code)).digest('hex');
}

// ── State file ─────────────────────────────────────────────────────────
function writeState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** null when off; { broken: true } when the file exists but is unusable. */
function readState() {
  let raw;
  try { raw = fs.readFileSync(stateFile(), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { broken: true };
  }
  try {
    const state = JSON.parse(raw);
    if (state && state.v === 1 && typeof state.secret === 'string' && Array.isArray(state.recovery)
        && /^[0-9a-f]{64}$/.test(state.recovery_key || '')) return state;
  } catch (_) { /* fall through */ }
  return { broken: true };
}

function isEnabled() { return readState() !== null; }

function status() {
  const state = readState();
  if (!state) return { enabled: false, recoveryLeft: 0, broken: false };
  if (state.broken) return { enabled: true, recoveryLeft: 0, broken: true };
  return { enabled: true, recoveryLeft: state.recovery.length, broken: false };
}

function freshRecovery(keyHex) {
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  return { codes, hashes: codes.map(c => hashRecovery(keyHex, c)) };
}

/**
 * Turn two-step sign-in on once `code` proves the app holds `secret`.
 * Returns the recovery codes, to be shown once.
 */
function enable(secret, code, { now = Date.now() } = {}) {
  const step = verifyTotp(secret, code, { now });
  if (step === null) return null;
  const keyHex = crypto.randomBytes(32).toString('hex');
  const { codes, hashes } = freshRecovery(keyHex);
  writeState({ v: 1, secret: encryptString(secret), recovery_key: keyHex, recovery: hashes, last_step: step, created: new Date(now).toISOString() });
  return codes;
}

/**
 * Check a sign-in code: the app's 6 digits, or an unused recovery code.
 * { ok, kind: 'totp' | 'recovery', reason? }. A used code never works again.
 */
function check(code, { now = Date.now() } = {}) {
  const state = readState();
  if (!state) return { ok: true, kind: 'none' };
  if (state.broken) return { ok: false, reason: 'broken' };
  const digits = String(code == null ? '' : code).replace(/\s+/g, '');
  if (/^\d{6}$/.test(digits)) {
    let secret;
    try { secret = decryptString(state.secret); } catch (_) {
      logger.error('Two-step sign-in: the secret cannot be decrypted (the encryption key changed); only recovery codes work');
      return { ok: false, reason: 'secret-unreadable' };
    }
    const step = verifyTotp(secret, digits, { now, lastStep: state.last_step });
    if (step === null) return { ok: false, reason: 'wrong' };
    state.last_step = step;
    writeState(state);
    return { ok: true, kind: 'totp' };
  }
  const hash = hashRecovery(state.recovery_key, code);
  const index = state.recovery.findIndex(h => crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex')));
  if (index < 0) return { ok: false, reason: 'wrong' };
  state.recovery.splice(index, 1);
  writeState(state);
  return { ok: true, kind: 'recovery', recoveryLeft: state.recovery.length };
}

/** Ten new recovery codes replace the old ones. Caller has checked a code. */
function regenerateRecovery() {
  const state = readState();
  if (!state || state.broken) return null;
  const { codes, hashes } = freshRecovery(state.recovery_key);
  state.recovery = hashes;
  writeState(state);
  return codes;
}

function disable() {
  try { fs.unlinkSync(stateFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// The Docker way to recover: RESET_TWO_STEP=true removes it at start.
function applyEnvReset() {
  if (/^(1|true|yes)$/i.test(process.env.RESET_TWO_STEP || '') && isEnabled()) {
    disable();
    logger.warn('Two-step sign-in was switched off by RESET_TWO_STEP. Remove that setting so it can be turned on again.');
    return true;
  }
  return false;
}

module.exports = {
  isEnabled, status, enable, check, disable, regenerateRecovery, applyEnvReset,
  generateSecret, otpauthUri, verifyTotp, codeAt, base32Encode, base32Decode, hotp,
  STEP_SECONDS, RECOVERY_COUNT
};
