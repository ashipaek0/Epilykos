#!/usr/bin/env node
/**
 * test/encryption-integrity.test.js — at-rest secret encryption integrity
 * (modules/encryption.js + modules/database.js slice B).
 *
 * Isolation: fresh mkdtemp ENC_KEY_FILE + scratch chdir with empty data/
 * (DB_PATH is CWD-relative './data/energy.db') — never touches the real
 * energy.db, never requires server.js. Plain-node assert script (exit code
 * gates test/run-all.js).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Isolation first, before requiring any repo modules ---------------------
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-int-key-'));
process.env.ENC_KEY_FILE = path.join(keyDir, 'encryption-key');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-int-db-'));
process.chdir(tmp);

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'modules', 'database.js'));

function freshEncryption() {
  const p = path.join(REPO, 'modules', 'encryption.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

db.initializeDatabase();

function rawValue(key) {
  return db.getDb().prepare('SELECT value FROM config WHERE key = ?').get(key).value;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. scalar secret encrypted at rest, decrypted on read
check('scalar secret encrypted at rest + read back', () => {
  const secret = 'solcast-super-secret-123';
  db.setConfig('solcast_api_key', secret);
  const raw = rawValue('solcast_api_key');
  assert.ok(raw.startsWith('$enc1$'), `expected $enc1$ envelope, got: ${raw.slice(0, 20)}`);
  assert.ok(!raw.includes(secret), 'plaintext must not appear at rest');
  assert.strictEqual(db.getConfig('solcast_api_key'), secret);
});

// 2. blob nested leaf encrypted at rest, deep-equal read-back, non-secrets kept
check('blob nested leaves encrypted at rest, non-secrets untouched', () => {
  const blob = [
    { name: 'Tuya A', uuid: 'u1', local_key: 'LK-SECRET-1', ip: '10.0.0.5' },
    { name: 'Tuya B', uuid: 'u2', local_key: 'LK-SECRET-2', ip: '10.0.0.6' },
  ];
  db.setConfig('tuya_devices', JSON.stringify(blob));
  const raw = rawValue('tuya_devices');
  assert.ok(!raw.includes('LK-SECRET-1') && !raw.includes('LK-SECRET-2'), 'plaintext leaves must not appear at rest');
  const stored = JSON.parse(raw);
  for (const d of stored) {
    assert.ok(d.local_key.startsWith('$enc1$'), 'leaf must be an envelope');
    assert.strictEqual(d.name.slice(0, 4), 'Tuya');
    assert.ok(d.ip.startsWith('10.0.0.'), 'non-secret leaf untouched at rest');
  }
  assert.deepStrictEqual(JSON.parse(db.getConfig('tuya_devices')), blob);
});

// 3. wrong-key decrypt throws (fresh module, different mkdtemp key file)
check('wrong-key decryptString throws', () => {
  const enc = freshEncryption();
  const envelope = enc.encryptString('hello');
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-int-other-'));
  process.env.ENC_KEY_FILE = path.join(otherDir, 'encryption-key');
  const enc2 = freshEncryption();
  assert.throws(() => enc2.decryptString(envelope), /./);
  process.env.ENC_KEY_FILE = path.join(keyDir, 'encryption-key');
  // original key still decrypts after restore
  assert.strictEqual(freshEncryption().decryptString(envelope), 'hello');
});

// 4. idempotent re-write: storing the envelope again is byte-identical
check('re-write of envelope is byte-identical (idempotent)', () => {
  db.setConfig('mqtt_password', 'pw-idem-1');
  const once = rawValue('mqtt_password');
  db.setConfig('mqtt_password', once); // envelope in, must pass through
  assert.strictEqual(rawValue('mqtt_password'), once);
  db.setConfig('tuya_devices', JSON.stringify([{ local_key: 'LK-IDEM' }]));
  const blobOnce = rawValue('tuya_devices');
  db.setConfig('tuya_devices', blobOnce);
  assert.strictEqual(rawValue('tuya_devices'), blobOnce);
  assert.deepStrictEqual(JSON.parse(db.getConfig('tuya_devices')), [{ local_key: 'LK-IDEM' }]);
});

// 5. migration: raw plaintext rows migrated, readable, re-run migrates 0
check('migrateSecretsToEncrypted migrates plaintext, re-run is no-op', () => {
  const scalarPlain = 'migrate-me-scalar';
  db.getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('ha_token', scalarPlain);
  db.getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('mqtt_devices', JSON.stringify([{ name: 'M', password: 'MIGRATE-PW' }]));
  assert.strictEqual(rawValue('ha_token'), scalarPlain, 'planted raw, bypassing setConfig');
  const r1 = db.migrateSecretsToEncrypted();
  assert.ok(r1.migrated >= 2, `expected >=2 migrated, got ${JSON.stringify(r1)}`);
  assert.ok(rawValue('ha_token').startsWith('$enc1$'), 'scalar migrated to envelope');
  assert.strictEqual(db.getConfig('ha_token'), scalarPlain, 'migrated scalar readable');
  assert.deepStrictEqual(JSON.parse(db.getConfig('mqtt_devices')), [{ name: 'M', password: 'MIGRATE-PW' }]);
  const r2 = db.migrateSecretsToEncrypted();
  assert.strictEqual(r2.migrated, 0, `re-run must migrate 0, got ${JSON.stringify(r2)}`);
});

// 6. non-secret key passthrough
check('non-secret key stored raw', () => {
  db.setConfig('some_plain_setting', 'hello-world');
  assert.strictEqual(rawValue('some_plain_setting'), 'hello-world');
  assert.strictEqual(db.getConfig('some_plain_setting'), 'hello-world');
});

// 7. non-JSON blob value stored raw, read back raw
check('non-JSON blob value stored raw', () => {
  const junk = 'not-json{{{oops';
  db.setConfig('tuya_devices', junk);
  assert.strictEqual(rawValue('tuya_devices'), junk);
  assert.strictEqual(db.getConfig('tuya_devices'), junk);
});

console.log(`\nencryption-integrity.test.js: ${passed} fixture(s) passed`);
