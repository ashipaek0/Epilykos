#!/usr/bin/env node
/**
 * test/appliance-mode.test.js — app behaviour EpilykosOS relies on.
 *
 *  - LOG_TO_FILE=false: no file transport and no log directory is created
 *    (a read-only container root must not crash the logger at require time).
 *  - SQLITE_SYNCHRONOUS: explicit durability mode; OFF is refused.
 *  - GET /healthz: 200 with schema/durability facts when healthy, 503 when the
 *    database is unusable, never leaks paths or configuration.
 *
 * Each case runs in a child process with its own scratch cwd/env so module
 * state (logger, database singleton) never leaks between cases.
 */
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function runChild(code, env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-appliance-'));
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { NODE_NO_WARNINGS: '1', ROOT }, env)
  });
  if (r.status !== 0) throw new Error(`child failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  const line = r.stdout.trim().split('\n').filter(l => l.startsWith('RESULT ')).pop();
  if (!line) throw new Error(`no RESULT line:\n${r.stdout}\n${r.stderr}`);
  return { result: JSON.parse(line.slice(7)), cwd, stdout: r.stdout };
}

function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---- logging ----
check('LOG_TO_FILE=false: no file transport, no log directory created', () => {
  const logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-logs-')), 'nested');
  const { result } = runChild(`
    const { logger, logToFile } = require(process.env.ROOT + '/modules/logger');
    logger.info('hello');
    console.log('RESULT ' + JSON.stringify({ logToFile, transports: logger.transports.map(t => t.name || t.constructor.name) }));
  `, { LOG_TO_FILE: 'false', LOG_DIR: logDir });
  assert.strictEqual(result.logToFile, false);
  assert.deepStrictEqual(result.transports, ['console']);
  assert.ok(!fs.existsSync(logDir), 'log directory must not be created');
});

check('default: rotating file transport writes under LOG_DIR', () => {
  const logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-logs-')), 'nested');
  const { result } = runChild(`
    const { logger, logToFile } = require(process.env.ROOT + '/modules/logger');
    console.log('RESULT ' + JSON.stringify({ logToFile, n: logger.transports.length }));
  `, { LOG_TO_FILE: '', LOG_DIR: logDir });
  assert.strictEqual(result.logToFile, true);
  assert.strictEqual(result.n, 2);
  assert.ok(fs.existsSync(logDir), 'log directory created for file logging');
});

// ---- SQLite durability ----
const durabilityChild = `
  const db = require(process.env.ROOT + '/modules/database');
  db.initializeDatabase();
  console.log('RESULT ' + JSON.stringify(db.getDurabilitySettings()));
`;
check('SQLite: default is explicit WAL + NORMAL', () => {
  const { result } = runChild(durabilityChild, { SQLITE_SYNCHRONOUS: '', LOG_TO_FILE: 'false' });
  assert.deepStrictEqual(result, { journal_mode: 'wal', synchronous: 'NORMAL' });
});
check('SQLite: SQLITE_SYNCHRONOUS=full selects FULL', () => {
  const { result } = runChild(durabilityChild, { SQLITE_SYNCHRONOUS: 'full', LOG_TO_FILE: 'false' });
  assert.strictEqual(result.synchronous, 'FULL');
});
check('SQLite: OFF is refused (falls back to NORMAL)', () => {
  const { result, stdout } = runChild(durabilityChild, { SQLITE_SYNCHRONOUS: 'OFF', LOG_TO_FILE: 'false' });
  assert.strictEqual(result.synchronous, 'NORMAL');
  assert.ok(/not allowed/.test(stdout), 'refusal is logged');
});

// ---- /healthz ----
const healthChild = (breakDb) => `
  const express = require(process.env.ROOT + '/node_modules/express');
  const db = require(process.env.ROOT + '/modules/database');
  db.initializeDatabase();
  ${breakDb ? "db.getDb().exec('DROP TABLE latest_metrics');" : ''}
  const app = express();
  app.use(require(process.env.ROOT + '/routes/health').router);
  const srv = app.listen(0, async () => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/healthz');
    const body = await r.json();
    console.log('RESULT ' + JSON.stringify({ status: r.status, body, cache: r.headers.get('cache-control') }));
    srv.close();
  });
`;
check('/healthz: 200 with durability facts, no secrets', () => {
  const { result } = runChild(healthChild(false), { LOG_TO_FILE: 'false', TZ: 'Africa/Lagos' });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.status, 'ok');
  assert.strictEqual(result.body.database.journal_mode, 'wal');
  assert.strictEqual(result.body.database.synchronous, 'NORMAL');
  assert.strictEqual(result.body.database.metric_flush_interval_ms, 5000);
  assert.strictEqual(result.body.timezone, 'Africa/Lagos');
  assert.strictEqual(result.cache, 'no-store');
  const text = JSON.stringify(result.body);
  assert.ok(!/password|token|secret|energy\.db|\/tmp\//i.test(text), `leaks: ${text}`);
});
check('/healthz: 503 when the schema is broken, without leaking paths', () => {
  const { result } = runChild(healthChild(true), { LOG_TO_FILE: 'false' });
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.body.status, 'error');
  assert.ok(/latest_metrics/.test(result.body.error));
  assert.ok(!/\/tmp\//.test(JSON.stringify(result.body)));
});

console.log(`\nPASS appliance-mode: ${passed} checks`);
