'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-serial-')), cwd = process.cwd();
process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.ENC_KEY_FILE = path.join(root, 'key');
const database = require('../modules/database'), work = require('../modules/databaseWork'), { restoreDatabase } = require('../modules/backup');
const ports = [], retries = [];
class FakePort extends EventEmitter {
  constructor(options) { super(); this.path = options.path; this.isOpen = true; ports.push(this); }
  pipe(parser) { return parser; }
  close() { this.isOpen = false; } // native close event may arrive after replacement
}
const serial = require('serialport');
require.cache[require.resolve('serialport')].exports = { ...serial, SerialPort: FakePort };
const rs232 = require('../modules/rs232');
require.cache[require.resolve('serialport')].exports = serial;
const setTimer = global.setTimeout, clearTimer = global.clearTimeout;
global.setTimeout = (fn, ms, ...args) => {
  if (ms !== 10000) return setTimer(fn, ms, ...args);
  const token = { serialRetry: true, fn: () => fn(...args), cancelled: false }; retries.push(token); return token;
};
global.clearTimeout = token => { if (token?.serialRetry) token.cancelled = true; else clearTimer(token); };
const device = file => ({ name: 'stream', enabled: true, profile: 'vedirect', serial_path: file, mappings: {} });
function fixture(selected) {
  rs232.shutdownRs232(); try { database.getDb().close(); } catch (_) {}
  fs.rmSync('data', { recursive: true, force: true }); database.initializeDatabase(); rs232.loadRs232Profiles();
  database.setConfig('rs232_devices', JSON.stringify([device('/old-port')]));
  const input = path.join(root, 'input-' + Math.random() + '.db'), db = new Database(input);
  db.exec('CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric)); CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);');
  db.prepare('INSERT INTO config VALUES(?,?)').run('rs232_devices', JSON.stringify(selected)); db.close();
  return input;
}
const lifecycle = { pause() { rs232.shutdownRs232(); }, resume() { rs232.restartRs232Streaming(); } };
after(() => { rs232.shutdownRs232(); global.setTimeout = setTimer; global.clearTimeout = clearTimer; try { database.getDb().close(); } catch (_) {} process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });

test('restore cancels retries and queued retired callbacks cannot reopen removed streams', async () => {
  const input = fixture([]), count = ports.length;
  work.run(() => rs232.restartRs232Streaming());
  work.run(() => ports.at(-1).emit('error', new Error('fixture disconnect')));
  const retry = retries.at(-1); assert.ok(retry);
  await restoreDatabase(input, { lifecycle });
  retry.fn(); // even a callback already queued before cancellation must be harmless
  assert.equal(ports.length, count + 1);
  assert.equal(retry.cancelled, true);
});

test('old serial close/error callbacks cannot erase the restored stream with the same name', async () => {
  const input = fixture([device('/new-port')]), count = ports.length;
  work.run(() => rs232.restartRs232Streaming()); const old = ports.at(-1);
  await restoreDatabase(input, { lifecycle });
  assert.equal(ports.at(-1).path, '/new-port');
  old.emit('close'); old.emit('error', new Error('late original error'));
  await work.run(() => rs232.pollRs232());
  assert.equal(ports.length, count + 2, 'the current open stream must stay registered');
});
