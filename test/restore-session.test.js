'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-session-')), cwd = process.cwd();
process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.ENC_KEY_FILE = path.join(root, 'key');
const database = require('../modules/database'); database.initializeDatabase();
const store = require('../modules/sessionStore').createSessionStore(require('express-session'));
after(() => { clearInterval(store._timer); database.getDb().close(); process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });
test('restore copies only current unexpired authorization and keeps its original deadline', () => {
  store.set('owner', { authenticated: true, cookie: { maxAge: 10000 } });
  const record = store.captureForRestore('owner'); assert.equal(record.sid, 'owner');
  store.destroy('owner'); assert.equal(store.captureForRestore('owner'), null);
  store.restoreCaptured(record);
  assert.equal(store._db().prepare('SELECT expires FROM sessions WHERE sid=?').get('owner').expires, record.expires);
  store._db().prepare('UPDATE sessions SET expires=0 WHERE sid=?').run('owner'); assert.equal(store.captureForRestore('owner'), null);
  store.set('guest', { cookie: {} }); assert.equal(store.captureForRestore('guest'), null);
  store.restoreCaptured(null);
});
