#!/usr/bin/env node
/**
 * test/backup-secrets.test.js — passphrase-protected saved passwords in a
 * backup (modules/backupSecrets.js): the secrets in the copy are locked with
 * the passphrase, a restore with the right passphrase brings them back under
 * ANOTHER box's key, a wrong one is refused before anything changes, and a
 * restore without the passphrase empties them.
 */
'use strict';
const checks = require('./_checks');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-sec-key-'));
process.env.ENC_KEY_FILE = path.join(keyDir, 'encryption-key');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-sec-db-'));
process.chdir(work);

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'modules', 'database.js'));
const secrets = require(path.join(REPO, 'modules', 'backupSecrets.js'));
const { decryptString, isEncrypted } = require(path.join(REPO, 'modules', 'encryption.js'));
const Database = require('better-sqlite3');
db.initializeDatabase();

const PASS = 'correct horse battery';
const MQTT_VALUE = 'mqtt-' + require('crypto').randomBytes(6).toString('hex');   // made fresh each run
const rawRows = file => {
  const d = new Database(file, { readonly: true });
  try { return Object.fromEntries(d.prepare('SELECT key, value FROM config').all().map(r => [r.key, r.value])); } finally { d.close(); }
};
const rejects = async (promise, code) => {
  try { await promise; } catch (e) { assert.strictEqual(e.code, code, e.message); return e; }
  assert.fail('expected ' + code);
};

(async () => {
  db.setConfig('solcast_api_key', 'solcast-secret-1');
  db.setConfig('mqtt_password', MQTT_VALUE);
  db.setConfig('ha_devices', JSON.stringify([{ name: 'house', token: 'ha-token-3', url: 'http://ha' }, { name: 'shed', token: 'ha-token-4' }]));
  db.setConfig('notification_vapid', JSON.stringify({ publicKey: 'PUB', privateKey: 'vapid-private-5' }));
  db.setConfig('network_local_url', 'http://192.168.1.2:3000');

  const copy = path.join(work, 'copy.db');
  await db.getDb().backup(copy);
  assert.ok(!secrets.inspect(copy), 'an ordinary backup has no marker');
  assert.ok(Object.values(rawRows(copy)).some(v => v.startsWith('$enc1$')), 'locked with the box key');
  console.log('ok - an ordinary backup is unchanged and has no protection marker');

  // Short passphrases are refused up front.
  await rejects(secrets.protect(copy, 'short'), 'PASSPHRASE_INVALID');
  await rejects(secrets.protect(copy, 12345), 'PASSPHRASE_INVALID');
  assert.ok(!rawRows(copy).backup_secrets_v1, 'a refused passphrase changes nothing');
  console.log('ok - a passphrase under 8 characters, or not text, is refused before anything changes');

  const result = await secrets.protect(copy, PASS);
  assert.strictEqual(result.protected, 5, 'two scalars and three leaves');
  const rows = rawRows(copy);
  const everything = JSON.stringify(rows);
  for (const plain of ['solcast-secret-1', 'mqtt-secret-2', 'ha-token-3', 'ha-token-4', 'vapid-private-5']) assert.ok(!everything.includes(plain), `${plain} is not in the file`);
  assert.ok(!rows.solcast_api_key.startsWith('$enc1$') && rows.solcast_api_key.startsWith('$encp1$'));
  assert.ok(JSON.parse(rows.ha_devices).every(d => String(d.token).startsWith('$encp1$')));
  assert.strictEqual(JSON.parse(rows.ha_devices)[0].name, 'house');
  assert.strictEqual(JSON.parse(rows.notification_vapid).publicKey, 'PUB', 'public parts are untouched');
  assert.strictEqual(rows.network_local_url, 'http://192.168.1.2:3000', 'ordinary settings are untouched');
  assert.ok(!Object.values(rows).some(v => typeof v === 'string' && v.includes('$enc1$')), 'no secret is left under the box key');
  console.log('ok - protecting locks every saved secret with the passphrase and nothing else');

  const marker = secrets.inspect(copy);
  assert.ok(marker && marker.kdf === 'scrypt' && marker.N === 32768);
  assert.ok(!JSON.stringify(marker).includes(PASS));
  await rejects(secrets.verify(marker, 'wrong passphrase'), 'PASSPHRASE_WRONG');
  assert.strictEqual(await secrets.verify(marker, PASS), true);
  assert.strictEqual(await secrets.verify(marker, ' ' + PASS.toUpperCase()).catch(e => e.code), 'PASSPHRASE_WRONG', 'case and spaces matter');
  const before = fs.readFileSync(copy);
  await rejects(secrets.unlock(copy, marker, 'not the passphrase'), 'PASSPHRASE_WRONG');
  assert.ok(before.equals(fs.readFileSync(copy)), 'a wrong passphrase leaves the file byte-for-byte alone');
  console.log('ok - a wrong passphrase is refused and the file is not touched');

  // Another box: a different box key.
  const restored = path.join(work, 'restored.db');
  fs.copyFileSync(copy, restored);
  fs.writeFileSync(process.env.ENC_KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  const out = await secrets.unlock(restored, marker, PASS);
  assert.strictEqual(out.unlocked, 5);
  const after = rawRows(restored);
  assert.ok(!after.backup_secrets_v1, 'the marker is removed');
  assert.ok(isEncrypted(after.solcast_api_key) && !after.solcast_api_key.startsWith('$encp1$'));
  assert.strictEqual(decryptString(after.solcast_api_key), 'solcast-secret-1', 'readable with the new box key');
  assert.strictEqual(decryptString(after.mqtt_password), MQTT_VALUE);
  assert.deepStrictEqual(JSON.parse(after.ha_devices).map(d => decryptString(d.token)), ['ha-token-3', 'ha-token-4']);
  assert.strictEqual(decryptString(JSON.parse(after.notification_vapid).privateKey), 'vapid-private-5');
  assert.strictEqual(after.network_local_url, 'http://192.168.1.2:3000');
  console.log('ok - the right passphrase brings every secret back, locked with the new box key');

  // Without the passphrase: restore anyway, secrets emptied.
  const bare = path.join(work, 'bare.db');
  fs.copyFileSync(copy, bare);
  const none = await secrets.unlock(bare, marker, null);
  assert.deepStrictEqual(none, { unlocked: 0, emptied: 5 });
  const bareRows = rawRows(bare);
  assert.strictEqual(bareRows.solcast_api_key, '');
  assert.deepStrictEqual(JSON.parse(bareRows.ha_devices).map(d => d.token), ['', '']);
  assert.ok(!bareRows.backup_secrets_v1);
  console.log('ok - restoring without the passphrase empties the secrets instead');

  // Damaged protection data is reported, not trusted.
  const bad = path.join(work, 'bad.db');
  fs.copyFileSync(copy, bad);
  const d = new Database(bad);
  d.prepare("UPDATE config SET value = ? WHERE key = 'backup_secrets_v1'").run(JSON.stringify({ v: 1, kdf: 'scrypt', N: 2 ** 30, r: 8, p: 1, salt: 'AA', check: '$encp1$AA' }));
  d.close();
  assert.throws(() => secrets.inspect(bad), e => e.code === 'BACKUP_SECRETS_DAMAGED');
  console.log('ok - damaged or hostile protection data (a huge scrypt cost) is refused');

  // Looking at a backup leaves no files beside it (restore refuses sidecars), but never hides ones already there.
  const wal = path.join(work, 'wal.db');
  const w = new Database(wal); w.pragma('journal_mode = WAL'); w.exec('CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT)'); w.pragma('wal_checkpoint(TRUNCATE)'); w.close();
  const listing = () => fs.readdirSync(work).filter(n => n.startsWith('wal.db')).sort();
  assert.deepEqual(listing(), ['wal.db']);
  assert.equal(secrets.inspect(wal), null);
  assert.deepEqual(listing(), ['wal.db'], 'no -wal or -shm left behind');
  fs.writeFileSync(wal + '-journal', 'x');
  assert.equal(secrets.inspect(wal), null, 'not opened; the restore refuses it');
  assert.deepEqual(listing(), ['wal.db', 'wal.db-journal'], 'a sidecar that was already there stays for the restore to refuse');
  console.log('ok - inspecting a backup leaves no sidecars of its own');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
