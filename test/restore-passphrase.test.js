'use strict';
/**
 * test/restore-passphrase.test.js — restoring a backup that was made with a
 * passphrase, through the real upload manager and restore: the restore waits
 * for the passphrase after the upload, a wrong one is refused and asked
 * again, the right one brings the saved passwords back under THIS box's key,
 * "without the saved passwords" restores with them emptied, and giving up
 * cancels cleanly.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-pass-')), cwd = process.cwd();
process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.ENC_KEY_FILE = path.join(root, 'key');
const db = require('../modules/database');
const secrets = require('../modules/backupSecrets');
const { createRestoreUploadManager } = require('../modules/restoreUploads');
const { acquireLock } = require('../modules/maintenanceLock');
const PASS = 'a long passphrase';

async function terminal(manager, id) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const status = manager.status(id);
    if (['selected', 'failed', 'cancelled', 'recovered', 'unknown'].includes(status.phase)) return status;
    if (Date.now() > deadline) throw new Error('restore did not finish: ' + JSON.stringify(status));
    await new Promise(r => setTimeout(r, 25));
  }
}
async function waitFor(manager, id, phase) {
  const deadline = Date.now() + 20000;
  while (manager.status(id).phase !== phase) {
    if (Date.now() > deadline) throw new Error('never reached ' + phase + ': ' + JSON.stringify(manager.status(id)));
    await new Promise(r => setTimeout(r, 25));
  }
}

// A protected backup of a box with saved passwords; then "another box": a new key and its own database.
async function protectedBackup() {
  try { db.getDb().close(); } catch (_) {}
  fs.rmSync('data', { recursive: true, force: true });
  fs.writeFileSync(process.env.ENC_KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  db.initializeDatabase();
  db.setConfig('solcast_api_key', 'solcast-from-old-box');
  db.setConfig('ha_devices', JSON.stringify([{ name: 'house', token: 'ha-token-from-old-box' }]));
  db.setConfig('upload_probe', 'from-the-backup');
  const file = path.join(root, 'protected-' + Math.random().toString(36).slice(2) + '.db');
  await db.getDb().backup(file);
  await secrets.protect(file, PASS);
  // The new box.
  db.getDb().close();
  fs.rmSync('data', { recursive: true, force: true });
  fs.writeFileSync(process.env.ENC_KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  db.initializeDatabase();
  db.setConfig('upload_probe', 'original');
  return file;
}
async function upload(manager, file) {
  const size = fs.statSync(file).size, job = await manager.create({ bytes: size, name: path.basename(file) });
  await manager.receive(job.id, 0, fs.createReadStream(file), size);
  return job;
}
after(() => { try { db.getDb().close(); } catch (_) {} process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });

test('the restore waits for the passphrase, refuses a wrong one, and a right one brings the passwords back under this box\'s key', async () => {
  const file = await protectedBackup(), manager = createRestoreUploadManager();
  try {
    const job = await upload(manager, file);
    await waitFor(manager, job.id, 'passphrase');
    assert.equal(db.getConfig('upload_probe'), 'original', 'nothing is replaced while it waits');
    await assert.rejects(acquireLock('maintenance', { timeoutMs: 0 }), /timed out/, 'the restore still holds the maintenance lock');
    await assert.rejects(manager.passphrase(job.id, { passphrase: 'not the passphrase' }), e => e.status === 422 && e.code === 'PASSPHRASE_WRONG');
    const waiting = manager.status(job.id);
    assert.equal(waiting.phase, 'passphrase');
    assert.match(waiting.error, /not right/, 'the dialog can say why');
    assert.ok(!JSON.stringify(waiting).includes('not the passphrase'));
    assert.ok(!fs.readFileSync(path.join('data', '.restore-upload-status.json'), 'utf8').includes(PASS), 'the passphrase is never written to the status file');
    await assert.rejects(manager.passphrase(job.id, { passphrase: 'short' }), e => e.status === 400);
    const accepted = await manager.passphrase(job.id, { passphrase: PASS });
    assert.equal(accepted.phase, 'preparing');
    assert.equal((await terminal(manager, job.id)).phase, 'selected');
    assert.equal(db.getConfig('upload_probe'), 'from-the-backup');
    assert.equal(db.getConfig('solcast_api_key'), 'solcast-from-old-box', 'readable with this box\'s key');
    assert.equal(JSON.parse(db.getConfig('ha_devices'))[0].token, 'ha-token-from-old-box');
    assert.deepEqual(db.unreadableSecrets(), []);
    assert.equal(db.getDb().prepare("SELECT 1 FROM config WHERE key = 'backup_secrets_v1'").get(), undefined, 'the marker is gone');
    await assert.rejects(manager.passphrase(job.id, { passphrase: PASS }), e => e.status === 409, 'only while waiting');
  } finally { await manager.close(); }
});

test('"restore without the saved passwords" restores everything else and empties them', async () => {
  const file = await protectedBackup(), manager = createRestoreUploadManager();
  try {
    const job = await upload(manager, file);
    await waitFor(manager, job.id, 'passphrase');
    await manager.passphrase(job.id, { skip: true });
    assert.equal((await terminal(manager, job.id)).phase, 'selected');
    assert.equal(db.getConfig('upload_probe'), 'from-the-backup');
    assert.equal(db.getConfig('solcast_api_key'), '');
    assert.equal(JSON.parse(db.getConfig('ha_devices'))[0].token, '');
    assert.equal(JSON.parse(db.getConfig('ha_devices'))[0].name, 'house');
  } finally { await manager.close(); }
});

test('cancelling while it waits for the passphrase leaves the live database alone and frees the lock', async () => {
  const file = await protectedBackup(), manager = createRestoreUploadManager();
  try {
    const job = await upload(manager, file);
    await waitFor(manager, job.id, 'passphrase');
    await manager.cancel(job.id);
    assert.equal(manager.status(job.id).phase, 'cancelled');
    assert.equal(db.getConfig('upload_probe'), 'original');
    (await acquireLock('maintenance', { timeoutMs: 0 }))();
  } finally { await manager.close(); }
});

test('an unattended passphrase prompt expires and cancels', async () => {
  const file = await protectedBackup(), manager = createRestoreUploadManager({ passphraseMs: 150 });
  try {
    const job = await upload(manager, file);
    await waitFor(manager, job.id, 'passphrase');
    assert.equal((await terminal(manager, job.id)).phase, 'cancelled');
    assert.equal(db.getConfig('upload_probe'), 'original');
  } finally { await manager.close(); }
});

test('an ordinary backup restores exactly as before, with no prompt', async () => {
  await protectedBackup();
  const plain = path.join(root, 'plain.db');
  db.setConfig('upload_probe', 'plain-backup');
  await db.getDb().backup(plain);
  const copy = new (require('better-sqlite3'))(plain); copy.pragma('journal_mode = DELETE'); copy.close();
  db.setConfig('upload_probe', 'original');
  const manager = createRestoreUploadManager();
  try {
    const job = await upload(manager, plain);
    assert.equal((await terminal(manager, job.id)).phase, 'selected');
    assert.equal(db.getConfig('upload_probe'), 'plain-backup');
  } finally { await manager.close(); }
});
