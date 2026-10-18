'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-key-publication-'));
const oldKey = process.env.ENC_KEY_FILE;
const encryption = require('../modules/encryption');
after(() => { if (oldKey) process.env.ENC_KEY_FILE = oldKey; else delete process.env.ENC_KEY_FILE; fs.rmSync(root, { recursive: true, force: true }); });

test('concurrent key publication retains the winner and decrypts both processes secrets', () => {
  const file = path.join(root, 'key'); process.env.ENC_KEY_FILE = file;
  const write = fs.writeFileSync, link = fs.linkSync;
  let competing, publishedKey;
  function otherWriter() {
    if (competing) return;
    competing = execFileSync(process.execPath, ['-e', `
      process.env.ENC_KEY_FILE = process.argv[2];
      process.stdout.write(require(process.argv[1]).encryptString('other writer secret'));
    `, require.resolve('../modules/encryption'), file], { encoding: 'utf8' });
    publishedKey = fs.readFileSync(file);
  }
  fs.writeFileSync = (target, ...args) => { if (target === file) otherWriter(); return write(target, ...args); };
  fs.linkSync = (source, target, ...args) => { if (target === file) otherWriter(); return link(source, target, ...args); };
  let own;
  try { own = encryption.encryptString('parent secret'); }
  finally { fs.writeFileSync = write; fs.linkSync = link; }
  assert.equal(encryption.decryptString(competing), 'other writer secret');
  assert.equal(encryption.decryptString(own), 'parent secret');
  assert.deepEqual(fs.readFileSync(file), publishedKey);
  assert.deepEqual(fs.readdirSync(root), ['key']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
