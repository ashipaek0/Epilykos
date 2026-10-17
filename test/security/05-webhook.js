'use strict';
/**
 * Unauthenticated PVOutput webhook. Before the fix, an attacker who guessed
 * the (semi-public) system_id could POST alerts with no auth. After the fix
 * the endpoint is closed unless PVOutput is enabled, and an optional
 * webhook_token locks it shut even when the system_id is known.
 *
 *   node test/security/05-webhook.js
 */
const { request, login, xhr } = require('./_client');
const results = [];
const add = (scenario, status, expectRefused) =>
  results.push({ scenario, status, refused: status === 403 || status === 400,
    verdict: (status === 403 || status === 400) === expectRefused ? 'ok' : (expectRefused ? 'VULNERABLE (accepted)' : 'unexpected-refusal') });

async function webhook(body, path = '/api/pvoutput/webhook') {
  // No session, no CSRF header — exactly an outside attacker.
  const r = await request('POST', path, { body: new URLSearchParams(body).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return r.status;
}

(async () => {
  const cookie = await login();
  const setCfg = (cfg) => request('POST', '/api/settings', { headers: xhr, cookie, body: { pvoutput_config: JSON.stringify(cfg) } });

  // 1. PVOutput configured but NOT enabled → endpoint closed.
  await setCfg({ system_id: '12345', api_key: 'x', enabled: false });
  add('configured, disabled → guessed sid', await webhook({ sid: '12345', type: '4', message: 'x' }), true);

  // 2. Enabled, correct sid, no token configured → accepted (legacy behaviour).
  await setCfg({ system_id: '12345', api_key: 'x', enabled: true });
  add('enabled, correct sid, no token → accepted', await webhook({ sid: '12345', type: '4', message: 'x' }), false);

  // 3. Enabled, WRONG sid → refused.
  add('enabled, wrong sid', await webhook({ sid: '99999', type: '4', message: 'x' }), true);

  // 4. Token configured, attacker lacks it → refused even with correct sid.
  await setCfg({ system_id: '12345', api_key: 'x', enabled: true, webhook_token: 'S3cretToken' });
  add('token set, correct sid, NO token → refused', await webhook({ sid: '12345', type: '4', message: 'x' }), true);
  add('token set, wrong token', await webhook({ sid: '12345', type: '4', message: 'x' }, '/api/pvoutput/webhook?token=nope'), true);

  // 5. Token configured, correct token → accepted (the legitimate caller).
  add('token set, correct token → accepted', await webhook({ sid: '12345', type: '4', message: 'x' }, '/api/pvoutput/webhook?token=S3cretToken'), false);

  // reset
  await setCfg({ system_id: '', api_key: '', enabled: false });

  console.log(JSON.stringify(results, null, 2));
  const bad = results.filter(r => r.verdict.startsWith('VULNERABLE'));
  console.error(`\n=== webhook: ${results.length} checks, ${bad.length} VULNERABLE ===`);
  for (const r of results) console.error(`  [${r.verdict.split(' ')[0]}] ${r.scenario} (HTTP ${r.status})`);
  process.exit(bad.length);
})().catch(e => { console.error(e); process.exit(255); });
