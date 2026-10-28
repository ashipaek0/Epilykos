#!/usr/bin/env node
/**
 * test/decrypt-failure.test.js — a saved secret that cannot be decrypted (the
 * encryption key is not the one that saved it: a backup restored onto a new
 * box) reads as EMPTY, not as its "$enc1$..." ciphertext. It is logged once,
 * listed in a notice until saved again, and the web push key pair is made
 * again instead of failing later with an unreadable private key.
 *
 * Isolation as test/encryption-integrity.test.js: a temp ENC_KEY_FILE and a
 * scratch data/ directory; never touches the real database.
 */
'use strict';
const checks = require('./_checks');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-fail-key-'));
process.env.ENC_KEY_FILE = path.join(keyDir, 'encryption-key');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'dec-fail-db-')));

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'modules', 'database.js'));
const { logger } = require(path.join(REPO, 'modules', 'logger.js'));
db.initializeDatabase();

const errors = [];
const realError = logger.error.bind(logger);
logger.error = (...a) => { errors.push(a.join(' ')); };

(async () => {
  db.setConfig('solcast_api_key', 'solcast-secret');
  db.setConfig('ha_devices', JSON.stringify([{ name: 'house', token: 'ha-token-1', url: 'http://ha' }]));
  db.setConfig('notification_vapid', JSON.stringify({ publicKey: 'OLDPUBLIC', privateKey: 'OLDPRIVATE' }));
  assert.strictEqual(db.getConfig('solcast_api_key'), 'solcast-secret');
  assert.deepStrictEqual(db.unreadableSecrets(), []);
  console.log('ok - with the right key everything reads back and nothing is flagged');

  // The new box: another key (a different 32 bytes) under the same file name.
  fs.writeFileSync(process.env.ENC_KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });

  assert.strictEqual(db.getConfig('solcast_api_key'), '', 'a scalar reads as empty');
  const devices = JSON.parse(db.getConfig('ha_devices'));
  assert.strictEqual(devices[0].token, '', 'a leaf reads as empty');
  assert.strictEqual(devices[0].name, 'house');
  assert.strictEqual(devices[0].url, 'http://ha', 'other fields are untouched');
  assert.ok(!db.getConfig('ha_devices').includes('$enc1$'));
  console.log('ok - an unreadable secret reads as empty, never as ciphertext');

  assert.deepStrictEqual(db.unreadableSecrets().sort(), ['Home Assistant device tokens', 'Solcast API key']);
  const before = errors.length;
  db.getConfig('solcast_api_key'); db.getConfig('solcast_api_key');
  assert.strictEqual(errors.length, before, 'logged once per secret, not on every read');
  assert.ok(errors.some(e => /solcast_api_key/.test(e) && /different box|encryption key/.test(e)));
  console.log('ok - each is logged once and listed by label');

  // The notice says which, in words.
  const notices = require(path.join(REPO, 'modules', 'notices.js'));
  const status = await notices.status();
  const notice = status.notices.find(n => n.id === 'secrets');
  assert.ok(notice, 'a notice is shown');
  assert.match(notice.message, /Solcast API key/);
  assert.match(notice.message, /Home Assistant device tokens/);
  assert.match(notice.message, /encryption key/);
  console.log('ok - a notice names the secrets to enter again');

  // Entering one again clears it from the list.
  db.setConfig('solcast_api_key', 'entered-again');
  assert.strictEqual(db.getConfig('solcast_api_key'), 'entered-again');
  assert.deepStrictEqual(db.unreadableSecrets(), ['Home Assistant device tokens']);
  console.log('ok - saving the value again clears it');

  // Web push: a new pair, not the unreadable private key.
  const store = require(path.join(REPO, 'modules', 'notifications', 'store.js'));
  const vapid = store.getVapid();
  assert.ok(vapid.privateKey && !vapid.privateKey.startsWith('$enc1$'), 'a usable private key');
  assert.notStrictEqual(vapid.publicKey, 'OLDPUBLIC');
  assert.strictEqual(store.getVapid().privateKey, vapid.privateKey, 'and the new pair is kept');
  assert.ok(!(await notices.status()).notices.some(n => /Web push/.test(n.message)), 'self-healing, so not a notice');
  console.log('ok - the web push key pair is made again and kept');

  logger.error = realError;
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
