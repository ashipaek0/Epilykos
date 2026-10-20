'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createBackupSnapshot } = require('../modules/sqliteSnapshot');

test('corrupt SQLite content is rejected instead of advertised as a valid snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-corrupt-backup-'));
  const db = new Database(path.join(dir, 'source.db'));
  try {
    db.exec('CREATE TABLE broken(value); INSERT INTO broken VALUES(1)');
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.exec("UPDATE sqlite_schema SET rootpage = 999999 WHERE name = 'broken'");
    await assert.rejects(createBackupSnapshot(db, path.join(dir, 'snapshot.db')), /malformed|quick_check|invalid|corrupt/i);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('already cancelled capture does not allocate a destination', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-cancel-backup-'));
  const db = new Database(':memory:');
  const target = path.join(dir, 'snapshot.db');
  try {
    await assert.rejects(createBackupSnapshot(db, target, { signal: AbortSignal.abort(new Error('client left')) }), /client left/);
    assert.equal(fs.existsSync(target), false);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling validation interrupts SQLite even while its native read is blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-stop-check-'));
  const db = new Database(path.join(dir, 'source.db'));
  db.exec('CREATE TABLE sample(value); INSERT INTO sample VALUES(1)');
  const target = path.join(dir, 'snapshot.db');
  const controller = new AbortController();
  let reader, locked = false, abortAt, settledAt;
  // Lock the completed capture before the validator opens it. SQLite's normal
  // five-second busy handler is synchronous native code, just like a long scan.
  const hold = setInterval(() => {
    if (locked || !fs.existsSync(target)) return;
    try {
      reader = new Database(target, { fileMustExist: true, timeout: 1 });
      reader.exec('BEGIN EXCLUSIVE'); locked = true;
      setTimeout(() => { abortAt = Date.now(); controller.abort(new Error('stop validation')); }, 250);
    } catch (_) { if (reader) reader.close(); reader = null; }
  }, 1);
  try {
    await assert.rejects(createBackupSnapshot(db, target, { signal: controller.signal }), /stop validation/);
    settledAt = Date.now();
    assert.ok(locked, 'fixture held a real SQLite file lock');
    assert.ok(settledAt - abortAt < 1500, `cancellation waited ${settledAt - abortAt} ms for native SQLite`);
  } finally {
    clearInterval(hold);
    if (reader) { reader.exec('ROLLBACK'); reader.close(); }
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
