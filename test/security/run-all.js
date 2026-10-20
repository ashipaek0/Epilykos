#!/usr/bin/env node
'use strict';
/**
 * Security attack suite for Epilykos. Starts a throwaway instance on a private
 * port with a temp DB, runs every attack script against it, and reports.
 * Run before a release:  node test/security/run-all.js
 *
 * Each script exits non-zero per confirmed vulnerability; this runner sums them.
 * These are real HTTP attacks (and a headless-browser XSS check), not code reads.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const PORT = process.env.SEC_PORT || 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-sec-'));

const SCRIPTS = ['01-access-control.js', '02-input-and-limits.js', '03-ssrf.js', '05-webhook.js', '04-stored-xss.js'];

function waitUp(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      http.get(`${BASE}/healthz`, r => { r.resume(); resolve(); }).on('error', () => {
        if (Date.now() > until) return reject(new Error('server did not start'));
        setTimeout(poll, 400);
      });
    })();
  });
}

(async () => {
  const srv = spawn('node', [path.join(ROOT, 'server.js')], {
    cwd: tmp,
    env: { ...process.env, SETTINGS_PASSWORD: 'testpass1234', PORT: String(PORT),
      ENC_KEY_FILE: path.join(tmp, 'enc-key'), LOG_TO_FILE: 'false', UPDATE_CHECK: 'off', BLUETOOTH: 'off' },
    stdio: 'ignore',
  });
  try {
    await waitUp();
    let fails = 0;
    for (const s of SCRIPTS) {
      process.stdout.write(`\n──> ${s}\n`);
      const r = spawnSync('node', [path.join(__dirname, s)], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, BASE_URL: BASE, TEST_PASSWORD: 'testpass1234' },
      });
      if (r.status) fails += r.status;
    }
    console.log(`\n=================================`);
    console.log(fails === 0 ? 'ALL CLEAR — 0 confirmed vulnerabilities' : `${fails} CONFIRMED VULNERABILITY VERDICT(S)`);
    process.exit(fails ? 1 : 0);
  } finally {
    srv.kill('SIGTERM');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(2); });
