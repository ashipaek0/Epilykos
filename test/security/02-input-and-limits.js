'use strict';
/**
 * Input abuse + limit bypass (authenticated admin, the only user):
 *  - negative / NaN / huge / empty / very-long values on numeric+string settings
 *  - does a value that should be rejected persist and come back?
 *  - write-lock: can /api/action change a device while "device changes" is off?
 *  - rate-limit: burst of logins — does the limiter actually cap them?
 *
 *   node test/security/02-input-and-limits.js
 */
const { request, login, anonymousSession, xhr } = require('./_client');
const results = [];
const add = (attack, detail, status, response, verdict) =>
  results.push({ attack, detail, status, response: String(response).slice(0, 100), verdict });

(async () => {
  const cookie = await login();

  // 1. Numeric settings: negative, NaN, huge, empty. Save then read back.
  const bad = {
    solar_latitude: '-9999', solar_capacity_kwp: 'NaN', solar_azimuth: '1e309',
    battery_capacity_kwh: '-50', savings_rate: 'abc', battery_min_soc: '',
  };
  let r = await request('POST', '/api/settings/solar', { headers: xhr, cookie, body: { solar_latitude: bad.solar_latitude, solar_capacity_kwp: bad.solar_capacity_kwp, solar_azimuth: bad.solar_azimuth } });
  const solarStatus = r.status;
  r = await request('POST', '/api/settings/savings', { headers: xhr, cookie, body: { battery_capacity_kwh: bad.battery_capacity_kwh, savings_rate: bad.savings_rate, battery_min_soc: bad.battery_min_soc } });
  const savingsStatus = r.status;
  const back = (await request('GET', '/api/settings', { headers: xhr, cookie })).body || {};
  const persistedJunk = ['-9999', 'NaN', '1e309', '-50', 'abc'].filter(v => JSON.stringify(back).includes(`"${v}"`));
  add('Numeric settings abuse', `solar HTTP ${solarStatus}, savings HTTP ${savingsStatus}; junk persisted: ${persistedJunk.join(',') || 'none'}`,
    solarStatus, persistedJunk.join(','), persistedJunk.length ? 'WEAK (stored invalid numbers)' : 'ok (rejected/sanitized)');

  // 2. Very long string + special chars in a string setting.
  const longTitle = 'A'.repeat(200000) + '"><svg/onload=alert(1)>';
  r = await request('POST', '/api/settings/branding', { headers: xhr, cookie, body: { dashboard_title: longTitle } });
  const stored = (await request('GET', '/api/settings', { headers: xhr, cookie })).body || {};
  const titleLen = (stored.dashboard_title || '').length;
  add('Long/special string (dashboard_title)', `HTTP ${r.status}; stored length ${titleLen} (sent ${longTitle.length})`,
    r.status, titleLen, titleLen >= 200000 ? 'WEAK (no length cap; 200k stored)' : 'ok (bounded)');

  // reset title to something sane
  await request('POST', '/api/settings/branding', { headers: xhr, cookie, body: { dashboard_title: 'Epilykos' } });

  // 3. Write-lock: lock device changes, then try /api/action.
  await request('POST', '/api/settings', { headers: xhr, cookie, body: { device_writes_enabled: 'false' } });
  r = await request('POST', '/api/action', { headers: xhr, cookie, body: { source: 'tuya', action: 'set', entity: 'x', device: 'x', params: { value: true } } });
  const lockedRefused = r.status === 403 || (r.body && /turn|lock|enable|disabled|not.*found/i.test(JSON.stringify(r.body)));
  add('Write-lock bypass (/api/action while locked)', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0,80)}`,
    r.status, JSON.stringify(r.body).slice(0,80), lockedRefused ? 'ok (refused while locked)' : 'VULNERABLE (acted while locked)');

  // 3b. controls/layout while locked (agent flagged this bypasses requireUnlocked)
  r = await request('POST', '/api/controls/layout', { headers: xhr, cookie, body: { layout: [] } });
  add('controls/layout while locked', `HTTP ${r.status}`, r.status, JSON.stringify(r.body).slice(0,60),
    r.status === 200 ? 'INFO (layout write allowed while locked — layout only, not a device write)' : `ok (${r.status})`);

  // 4. Rate-limit: fire 25 bad logins, count how many were NOT 429.
  const anonymous = await anonymousSession();
  let accepted = 0, limited = 0;
  for (let i = 0; i < 25; i++) {
    const lr = await request('POST', '/api/login', { ...anonymous, body: { password: 'wrong' + i } });
    if (lr.status !== 401 && lr.status !== 429) throw new Error('Login rate-limit probe did not reach authentication: ' + lr.status);
    if (lr.status === 429) limited++; else accepted++;
  }
  add('Login rate-limit burst (25 attempts)', `${accepted} reached handler, ${limited} rate-limited (429)`,
    429, `${accepted}/${limited}`, limited > 0 ? 'ok (limiter engaged)' : 'WEAK (no limiting seen)');

  console.log(JSON.stringify(results, null, 2));
  const vulns = results.filter(r => r.verdict.startsWith('VULNERABLE'));
  console.error(`\n=== input/limits: ${results.length} checks, ${vulns.length} VULNERABLE, ${results.filter(r=>r.verdict.startsWith('WEAK')).length} WEAK ===`);
  for (const r of results) console.error(`  [${r.verdict.split(' ')[0]}] ${r.attack}`);
  process.exit(vulns.length);
})().catch(e => { console.error(e); process.exit(255); });
