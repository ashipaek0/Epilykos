'use strict';
/**
 * Stored-XSS, proven in a real browser. Seed attacker payloads into fields an
 * attacker could reach (dashboard title/branding, a Tuya device name, a
 * combined-metric fallback label, the dashboard background image), then load
 * the dashboard and settings pages in headless Chromium and record any script
 * execution (window.__xss set by the payload, or a dialog opening).
 *
 *   node test/security/04-stored-xss.js
 * Requires playwright-core (path below) and the local test server.
 */
// Resolve Playwright from the project, a PW_PATH override, or skip if absent
// (the HTTP attacks still run; only this browser-rendered check needs a browser).
function loadChromium() {
  const tries = [process.env.PW_PATH, 'playwright-core', 'playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t).chromium; } catch (_) {} }
  return null;
}
const chromium = loadChromium();
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const { request, login, xhr, BASE } = require('./_client');

const PAYLOAD = (tag) => `<img src=x onerror="window.__xss='${tag}'">` ;
const SVG = (tag) => `<svg onload="window.__xss='${tag}'">`;

(async () => {
  if (!chromium) { console.error('SKIPPED: playwright-core not installed (set PW_PATH to run the browser XSS check)'); process.exit(0); }
  const cookie = await login();
  // Seed stored fields.
  await request('POST', '/api/settings/branding', { headers: xhr, cookie, body: {
    dashboard_title: PAYLOAD('title'),
    dashboard_logo: 'javascript:window.__xss="logo"',
    dashboard_bg_image: 'x);}</style><img src=y onerror="window.__xss=\'bg\'">' } });
  await request('POST', '/api/settings', { headers: xhr, cookie, body: {
    tuya_devices: JSON.stringify([{ name: SVG('tuya'), dev_id: 'bf1', address: '1.2.3.4', local_key: 'k', enabled: true, dps: { ['m'+SVG('metric')]: '1' } }]) } });
  // A dashboard with a card whose title/label carry a payload.
  await request('POST', '/api/dashboard-config', { headers: xhr, cookie, body: {
    dashboards: [{ id: 'main', name: SVG('tabname'), layout: [
      { id: 'b1', type: 'metric-card', gridX:0,gridY:0,gridW:3,gridH:3, enabled:true,
        config: { enabled:true, metric: 'm', name: PAYLOAD('card'), label: PAYLOAD('cardlabel'), title: PAYLOAD('cardtitle') } },
    ] }], activeDashboard: 'main' } });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--headless=new','--no-sandbox'] });
  const results = [];
  for (const [name, path, authed] of [['dashboard (logged out)', '/', false], ['dashboard (admin)', '/', true], ['settings', '/settings', true]]) {
    const ctx = await browser.newContext();
    if (authed) await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE }]);
    const page = await ctx.newPage();
    let dialog = false;
    page.on('dialog', d => { dialog = true; d.dismiss().catch(()=>{}); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(()=>{});
    await page.waitForTimeout(2500);
    const fired = await page.evaluate(() => window.__xss || null).catch(()=>null);
    results.push({ page: name, path, xssFired: fired, dialog, verdict: (fired || dialog) ? 'VULNERABLE: '+(fired||'dialog') : 'ok (no execution)' });
    await ctx.close();
  }
  await browser.close();

  // Reset seeded fields so the DB is clean for later tests.
  await request('POST', '/api/settings/branding', { headers: xhr, cookie, body: { dashboard_title: 'Epilykos', dashboard_logo: '', dashboard_bg_image: '' } });
  await request('POST', '/api/settings', { headers: xhr, cookie, body: { tuya_devices: '[]' } });

  console.log(JSON.stringify(results, null, 2));
  const vulns = results.filter(r => r.verdict.startsWith('VULNERABLE'));
  console.error(`\n=== stored-xss (browser): ${results.length} pages, ${vulns.length} VULNERABLE ===`);
  for (const v of vulns) console.error('  VULN:', v.page, v.xssFired || 'dialog');
  process.exit(vulns.length);
})().catch(e => { console.error(e); process.exit(255); });
