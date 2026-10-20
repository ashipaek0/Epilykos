'use strict';
/**
 * Access-control attacks against Epilykos (single-admin app).
 * Confirms: every state-changing endpoint, and every endpoint that returns
 * secrets, refuses an unauthenticated caller and a forged/old session cookie.
 *
 *   node test/security/01-access-control.js        # BASE_URL=http://127.0.0.1:8099
 *
 * A row is a FAIL (vulnerability) when something that should be refused was
 * allowed. Exit code is the number of failures.
 */
const { request, login, anonymousSession, xhr } = require('./_client');

// Routes that change state or expose config. Each: method, path, sample body.
const PROTECTED = [
  ['POST', '/api/settings', { dashboard_title: 'x' }],
  ['POST', '/api/settings/network', { network_local_url: 'http://x' }],
  ['POST', '/api/settings/branding', { dashboard_title: 'x' }],
  ['POST', '/api/action', { source: 'tuya', action: 'set', entity: 'x', device: 'x', params: { value: true } }],
  ['POST', '/api/controls/change', { device: 'x', setting: 'y', value: 1 }],
  ['POST', '/api/controls/unlock', { password: 'nope' }],
  ['POST', '/api/metrics/create', { name: 'evil', unit: 'x' }],
  ['DELETE', '/api/metrics/evil', null],
  ['POST', '/api/dashboard-config', { dashboards: [] }],
  ['POST', '/api/dashboard-config/import', { dashboards: [] }],
  ['POST', '/api/restore', { x: 1 }],
  ['POST', '/api/snapshots/restore/x', null],
  ['POST', '/api/dongle/test', { transport: 'tcp', host: '127.0.0.1' }],
  ['POST', '/api/tuya-cloud-fetch', { region: 'eu' }],
  ['POST', '/api/wizard/reset', {}],
  ['POST', '/api/updates/apply', { password: 'nope' }],
  ['POST', '/api/updates/check', {}],
  ['POST', '/api/remote/tailscale/connect', {}],
  ['POST', '/api/logs/level', { level: 'debug' }],
  ['POST', '/api/system/restart', {}],
  ['GET', '/api/settings', null],          // may contain secrets
  ['GET', '/api/backup', null],            // full config dump
  ['GET', '/api/snapshots', null],
  ['GET', '/api/logs/diagnostics', null],
];

const results = [];
function record(attack, detail, req, resp, refused, shouldRefuse = true) {
  const vuln = shouldRefuse && !refused;
  results.push({ attack, detail, request: req, status: resp.status,
    response: typeof resp.body === 'string' ? resp.body.slice(0, 120) : JSON.stringify(resp.body).slice(0, 160),
    refused, verdict: vuln ? 'VULNERABLE' : 'ok' });
  return vuln;
}
const refusedStatus = s => s === 401 || s === 403 || s === 404;

(async () => {
  let fails = 0;

  // 1. Missing token/session: the CSRF or authentication layer must refuse.
  for (const [method, path, body] of PROTECTED) {
    const r = await request(method, path, { body, headers: xhr });
    if (record('No-auth direct request', `${method} ${path}`, `${method} ${path}`, r, refusedStatus(r.status))) fails++;
  }

  // 2. Forged / garbage session cookie.
  const forged = 'connect.sid=s%3Aforged-garbage-value.deadbeef';
  for (const [method, path, body] of PROTECTED) {
    const r = await request(method, path, { body, headers: xhr, cookie: forged });
    if (record('Forged session cookie', `${method} ${path}`, `${method} ${path} (cookie=forged)`, r, refusedStatus(r.status))) fails++;
  }

  // Pass CSRF with an anonymous session so unsafe probes reach authentication.
  const anonymous = await anonymousSession();
  for (const [method, path, body] of PROTECTED) {
    const r = await request(method, path, { ...anonymous, body });
    if (record('Anonymous session with valid CSRF', `${method} ${path}`, `${method} ${path}`, r, r.status === 401)) fails++;
  }

  // 3. Sanity: a real session IS accepted for a read (proves the probe works).
  const cookie = await login();
  const ok = await request('GET', '/api/settings', { cookie, headers: xhr });
  results.push({ attack: 'Control: real session', detail: 'GET /api/settings', request: 'GET /api/settings (authed)', status: ok.status, response: '[settings]', refused: ok.status !== 200, verdict: ok.status === 200 ? 'ok' : 'PROBE-BROKEN' });

  // 4. Does GET /api/settings leak secrets to a logged-IN caller that it
  //    should mask? (tokens, local keys, passwords). Informational.
  const settings = ok.body || {};
  const asText = JSON.stringify(settings);
  const leakHints = ['local_key', 'tuya', 'token', 'secret', 'password'].filter(k => new RegExp(`"[^"]*${k}[^"]*":"(?!(\\[hidden\\]|\\*|))`, 'i').test(asText));
  results.push({ attack: 'Secret exposure (authed GET /api/settings)', detail: 'keys with non-masked values', request: 'GET /api/settings', status: ok.status, response: leakHints.length ? `possible: ${leakHints.join(',')}` : 'none obvious', refused: '-', verdict: 'info' });

  console.log(JSON.stringify(results, null, 2));
  const vulns = results.filter(r => r.verdict === 'VULNERABLE');
  console.error(`\n=== access-control: ${results.length} checks, ${vulns.length} VULNERABLE ===`);
  for (const v of vulns) console.error(`  VULN: ${v.attack} — ${v.detail} → HTTP ${v.status}`);
  process.exit(vulns.length);
})().catch(e => { console.error(e); process.exit(255); });
