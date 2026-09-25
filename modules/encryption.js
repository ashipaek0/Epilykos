'use strict';
/**
 * modules/encryption.js — at-rest secret encryption (persistent-key design).
 *
 * - Key: dedicated persistent 32-byte raw key in `data/encryption-key`
 *   (0600, generated once via crypto.randomBytes if absent). DECOUPLED from
 *   the settings password so password changes never brick stored secrets.
 *   Tests override the path via `ENC_KEY_FILE`.
 * - Envelope: '$enc1$' + base64url(JSON {v:1, alg:'aes-256-gcm',
 *   iv(12B, b64), tag(b64), data(b64)}). The prefix enables idempotency
 *   checks and lets readers skip non-envelopes (partial-migration safety).
 * - Pure + fs key file only. No DB access from this module.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = '$enc1$';
const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

function keyFilePath() {
  return process.env.ENC_KEY_FILE || path.join(__dirname, '..', 'data', 'encryption-key');
}

function loadOrCreateKey() {
  const file = keyFilePath();
  try {
    const raw = fs.readFileSync(file);
    if (raw.length === KEY_BYTES) return raw;
    // Wrong-size file: refuse rather than silently re-key (would brick secrets).
    throw new Error(`encryption: key file ${file} has ${raw.length} bytes, expected ${KEY_BYTES}`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best-effort on odd FS */ }
  return key;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(s) {
  return Buffer.from(String(s), 'base64url');
}

function encryptString(plaintext) {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = JSON.stringify({
    v: 1,
    alg: ALG,
    iv: b64urlEncode(iv),
    tag: b64urlEncode(tag),
    data: b64urlEncode(ct),
  });
  return PREFIX + b64urlEncode(Buffer.from(body, 'utf8'));
}

function parseEnvelope(s) {
  if (typeof s !== 'string' || !s.startsWith(PREFIX)) return null;
  try {
    const body = JSON.parse(b64urlDecode(s.slice(PREFIX.length)).toString('utf8'));
    if (body && body.v === 1 && body.alg === ALG
      && typeof body.iv === 'string' && typeof body.tag === 'string'
      && typeof body.data === 'string') {
      return {
        iv: b64urlDecode(body.iv),
        tag: b64urlDecode(body.tag),
        data: b64urlDecode(body.data),
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function isEncrypted(s) {
  return parseEnvelope(s) !== null;
}

function decryptString(envelope) {
  const parts = parseEnvelope(envelope);
  if (!parts) throw new Error('encryption: not a valid $enc1$ envelope');
  const key = loadOrCreateKey();
  const decipher = crypto.createDecipheriv(ALG, key, parts.iv);
  decipher.setAuthTag(parts.tag);
  // Throws on wrong key / tamper / auth-tag failure.
  const pt = Buffer.concat([decipher.update(parts.data), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * SECRET_FIELDS registry for slice B: configKey -> [leaf field names].
 * `[]` means the whole config value is itself the secret (scalar top-level
 * key, e.g. solcast_api_key). Otherwise the listed LEAF fields are encrypted
 * wherever they appear in that config value (objects recursed, arrays
 * recursed, case-insensitive match).
 *
 * Inventory notes (verified against this repo):
 * - mqtt_username is NOT secret (omitted); mqtt_password is.
 * - ha_token is legacy top-level scalar (kept for back-compat).
 * - tuya_cloud stores OAuth tokens only (access_token/refresh_token);
 *   no client_secret exists in this codebase — omitted.
 * - tuya_devices[].local_key, ha_devices[].token, mqtt_devices[].password
 *   verified in modules/tuya.js, modules/ha.js, modules/mqtt.js.
 * - pvoutput_config.api_key verified in modules/pvoutput.js.
 * - dongle_config instances carry serials only (dongle_serial /
 *   inverter_serial / serial_number); no credential fields exist —
 *   no dongle entry (revisit if credential fields are ever added).
 */
const SECRET_FIELDS = {
  solcast_api_key: [],
  mqtt_password: [],
  ha_token: [],
  pvoutput_config: ['api_key'],
  tuya_cloud: ['access_token', 'refresh_token'],
  ha_devices: ['token'],
  mqtt_devices: ['password'],
  tuya_devices: ['local_key'],
};

function cloneDeep(v) {
  // Config values are JSON-shaped; structuredClone handles them exactly.
  return typeof structuredClone === 'function'
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));
}

function walkLeaves(node, fn) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (node[i] !== null && typeof node[i] === 'object') walkLeaves(node[i], fn);
      else fn(node, i);
    }
  } else if (node !== null && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (node[k] !== null && typeof node[k] === 'object') walkLeaves(node[k], fn);
      else fn(node, k);
    }
  }
}

/**
 * Deep-clone `obj`, encrypting matching string LEAF fields.
 * Idempotent: leaves already holding an envelope are left alone.
 */
function encryptSecretFields(obj, fieldNames) {
  const out = cloneDeep(obj);
  const wanted = new Set((fieldNames || []).map((f) => String(f).toLowerCase()));
  if (wanted.size === 0) return out;
  walkLeaves(out, (parent, key) => {
    if (!wanted.has(String(key).toLowerCase())) return;
    const v = parent[key];
    if (typeof v !== 'string' || v === '' || isEncrypted(v)) return;
    parent[key] = encryptString(v);
  });
  return out;
}

/**
 * Inverse: deep-clone `obj`, decrypting matching LEAF fields that hold an
 * envelope. Non-envelopes pass through untouched (partial-migration safety).
 */
function decryptSecretFields(obj, fieldNames) {
  const out = cloneDeep(obj);
  const wanted = new Set((fieldNames || []).map((f) => String(f).toLowerCase()));
  if (wanted.size === 0) return out;
  walkLeaves(out, (parent, key) => {
    if (!wanted.has(String(key).toLowerCase())) return;
    const v = parent[key];
    if (typeof v !== 'string' || !isEncrypted(v)) return;
    parent[key] = decryptString(v);
  });
  return out;
}

module.exports = {
  PREFIX,
  SECRET_FIELDS,
  keyFilePath,
  encryptString,
  decryptString,
  isEncrypted,
  encryptSecretFields,
  decryptSecretFields,
};
