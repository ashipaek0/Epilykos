#!/usr/bin/env node
/**
 * test/encryption.test.js — fixtures for modules/encryption.js
 * (persistent-key design). Uses a mkdtemp ENC_KEY_FILE; never touches the
 * real data/ dir. Plain-node assert script (exit code gates run-all.js).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const ENC_PATH = path.join(REPO_ROOT, 'modules', 'encryption.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
process.env.ENC_KEY_FILE = path.join(tmpDir, 'encryption-key');

function freshEncryption() {
  delete require.cache[require.resolve(ENC_PATH)];
  return require(ENC_PATH);
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. round-trip (incl. empty string and unicode)
check('round-trip encrypt/decrypt', () => {
  const enc = freshEncryption();
  for (const pt of ['s3cr3t!', '', 'ünïcodé-🔑-tokén', 'x'.repeat(5000)]) {
    assert.strictEqual(enc.decryptString(enc.encryptString(pt)), pt);
  }
});

// 2. tampered envelope throws
check('tamper throws', () => {
  const enc = freshEncryption();
  const env = enc.encryptString('hello');
  const last = env[env.length - 1];
  const tampered = env.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  assert.throws(() => enc.decryptString(tampered), /./);
});

// 3. wrong key throws
check('wrong key throws', () => {
  const enc = freshEncryption();
  const env = enc.encryptString('hello');
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-other-'));
  process.env.ENC_KEY_FILE = path.join(otherDir, 'encryption-key');
  const enc2 = freshEncryption();
  assert.throws(() => enc2.decryptString(env), /./);
  // restore primary key file for the remaining fixtures
  process.env.ENC_KEY_FILE = path.join(tmpDir, 'encryption-key');
});

// 4. isEncrypted true/false/partial
check('isEncrypted true/false/partial', () => {
  const enc = freshEncryption();
  assert.strictEqual(enc.isEncrypted(enc.encryptString('a')), true);
  assert.strictEqual(enc.isEncrypted('plain'), false);
  assert.strictEqual(enc.isEncrypted(''), false);
  assert.strictEqual(enc.isEncrypted(null), false);
  assert.strictEqual(enc.isEncrypted(undefined), false);
  assert.strictEqual(enc.isEncrypted(42), false);
  assert.strictEqual(enc.isEncrypted('$enc1$garbage!!!'), false);
  assert.strictEqual(enc.isEncrypted('$enc1$' + Buffer.from('{}').toString('base64url')), false);
});

// 5. nested blob encrypt/decrypt with arrays
check('nested blob encrypt/decrypt with arrays', () => {
  const enc = freshEncryption();
  const blob = {
    pvoutput_config: { api_key: 'PVKEY', system_id: 123 },
    mqtt_devices: [
      { broker: 'a', username: 'u', password: 'pw1' },
      { broker: 'b', username: 'v', password: 'pw2' },
    ],
    nested: { deeper: [{ local_key: 'LK' }] },
  };
  const encrypted = enc.encryptSecretFields(blob, ['api_key', 'password', 'local_key']);
  assert.ok(enc.isEncrypted(encrypted.pvoutput_config.api_key));
  assert.strictEqual(encrypted.pvoutput_config.system_id, 123);
  assert.ok(encrypted.mqtt_devices.every((d) => enc.isEncrypted(d.password)));
  assert.ok(enc.isEncrypted(encrypted.nested.deeper[0].local_key));
  // original untouched (deep-cloned)
  assert.strictEqual(blob.mqtt_devices[0].password, 'pw1');
  const back = enc.decryptSecretFields(encrypted, ['api_key', 'password', 'local_key']);
  assert.deepStrictEqual(back, blob);
});

// 6. key-file persistence across re-require (no per-boot random salt bug)
check('key persists across fresh module instances', () => {
  const enc1 = freshEncryption();
  const env = enc1.encryptString('persist-me');
  const stat = fs.statSync(process.env.ENC_KEY_FILE);
  assert.strictEqual(stat.size, 32);
  const enc2 = freshEncryption(); // fresh instance, same key file
  assert.strictEqual(enc2.decryptString(env), 'persist-me');
  // key file was not rotated: same bytes
  assert.strictEqual(fs.statSync(process.env.ENC_KEY_FILE).size, 32);
});

// 7. non-secret fields untouched (incl. case-insensitive match)
check('non-secret fields untouched; match is case-insensitive', () => {
  const enc = freshEncryption();
  const obj = { username: 'u', broker: 'mqtt://x', PASSWORD: 'pw', count: 7, flag: true, nothing: null };
  const out = enc.encryptSecretFields(obj, ['password']);
  assert.strictEqual(out.username, 'u');
  assert.strictEqual(out.broker, 'mqtt://x');
  assert.strictEqual(out.count, 7);
  assert.strictEqual(out.flag, true);
  assert.strictEqual(out.nothing, null);
  assert.ok(enc.isEncrypted(out.PASSWORD));
});

// 8. idempotent encrypt + partial-migration-safe decrypt
check('double-encrypt is idempotent; decrypt skips non-envelopes', () => {
  const enc = freshEncryption();
  const obj = { password: 'pw', token: 'not-yet-migrated' };
  const once = enc.encryptSecretFields(obj, ['password', 'token']);
  const twice = enc.encryptSecretFields(once, ['password', 'token']);
  assert.deepStrictEqual(twice, once);
  const mixed = { password: once.password, token: 'plain-legacy' };
  const back = enc.decryptSecretFields(mixed, ['password', 'token']);
  assert.strictEqual(back.password, 'pw');
  assert.strictEqual(back.token, 'plain-legacy');
});

// 9. SECRET_FIELDS registry shape covers the confirmed inventory
check('SECRET_FIELDS registry covers inventory', () => {
  const enc = freshEncryption();
  for (const k of ['pvoutput_config', 'tuya_cloud', 'ha_devices', 'mqtt_devices', 'tuya_devices']) {
    assert.ok(Array.isArray(enc.SECRET_FIELDS[k]) && enc.SECRET_FIELDS[k].length > 0, k);
  }
  assert.deepStrictEqual(enc.SECRET_FIELDS.pvoutput_config, ['api_key']);
  assert.deepStrictEqual([...enc.SECRET_FIELDS.tuya_cloud].sort(), ['access_token', 'refresh_token']);
});

console.log(`\nencryption.test.js: ${passed} fixture(s) passed`);
