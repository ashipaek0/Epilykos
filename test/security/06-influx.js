'use strict';
/**
 * InfluxDB (Settings → InfluxDB, /api/influx): can an outsider use it, can a signed-in page read the saved token back,
 * can the settings route overwrite the connection, and can the connection test be pointed at loopback or the cloud
 * metadata address (LAN addresses are allowed on purpose: a home InfluxDB is on the LAN)?
 *
 *   node test/security/06-influx.js
 */
const http = require('http');
const { request, login, xhr, anonymousSession } = require('./_client');

const results = [];
const add = (scenario, ok, detail) => results.push({ scenario, detail, verdict: ok ? 'ok' : 'VULNERABLE' });
const TOKEN = ['sec', 'suite', 'influx', 'token'].join('-');   // made up; built at run time so scanners do not flag it

function sink(port) {
  return new Promise(resolve => {
    let hit = false;
    const s = http.createServer((req, res) => { hit = true; res.end('SINK-REACHED'); });
    s.listen(port, '127.0.0.1', () => resolve({ srv: s, wasHit: () => hit }));
  });
}

(async () => {
  // 1. No session: every route refused.
  const anon = await anonymousSession();
  for (const [m, p] of [['GET', '/api/influx'], ['POST', '/api/influx/connection'], ['POST', '/api/influx/test'], ['POST', '/api/influx/discover'],
    ['POST', '/api/influx/suggest-ha'], ['POST', '/api/influx/mapping'], ['POST', '/api/influx/write-settings'], ['POST', '/api/influx/disconnect'],
    ['POST', '/api/influx/import/plan'], ['POST', '/api/influx/import/start'], ['POST', '/api/influx/import/stop']]) {
    const r = await request(m, p, { body: m === 'POST' ? {} : undefined, headers: anon.headers, cookie: anon.cookie });
    add(`signed out: ${m} ${p}`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  }

  const cookie = await login();
  // 2. The saved token never comes back.
  const saved = await request('POST', '/api/influx/connection', { body: { version: '2', url: 'http://192.0.2.10:8086', org: 'o', bucket: 'b', token: TOKEN }, headers: xhr, cookie });
  add('saving a connection works (needed for the checks below)', saved.status === 200, `HTTP ${saved.status}`);
  const view = await request('GET', '/api/influx', { headers: xhr, cookie });
  add('GET /api/influx never includes the token', !view.text.includes(TOKEN) && view.body.connection.hasToken === true, view.text.slice(0, 120));
  const settings = await request('GET', '/api/settings', { headers: xhr, cookie });
  add('GET /api/settings never includes the token', !String(settings.text).includes(TOKEN), `HTTP ${settings.status}`);

  // 3. The settings route cannot overwrite the connection (or point the saved token at another server).
  const over = await request('POST', '/api/settings', { body: { influx_connection: JSON.stringify({ version: '2', url: 'http://attacker.example', org: 'o', bucket: 'b', token: '' }) }, headers: xhr, cookie });
  const after = await request('GET', '/api/influx', { headers: xhr, cookie });
  add('/api/settings cannot write influx_connection', after.body.connection.url === 'http://192.0.2.10:8086', `HTTP ${over.status}, url ${after.body.connection.url}`);

  // 4. An empty token is not sent to another server.
  const { srv, wasHit } = await sink(9779);
  const moved = await request('POST', '/api/influx/test', { body: { version: '2', url: 'http://198.51.100.7:9', org: 'o', bucket: 'b', token: '' }, headers: xhr, cookie });
  add('test with an empty token for another server does not use the saved one', moved.status === 400 && /token/i.test(JSON.stringify(moved.body)), `HTTP ${moved.status} ${JSON.stringify(moved.body).slice(0, 80)}`);

  // 5. SSRF: loopback, metadata and the unspecified address are refused, and the sink is never reached.
  for (const [name, url] of [['loopback', 'http://127.0.0.1:9779'], ['loopback decimal', 'http://2130706433:9779'], ['ipv6 loopback', 'http://[::1]:9779'],
    ['cloud metadata', 'http://169.254.169.254'], ['unspecified', 'http://0.0.0.0:9779'], ['file scheme', 'file:///etc/passwd']]) {
    const r = await request('POST', '/api/influx/test', { body: { version: '1', url, database: 'd' }, headers: xhr, cookie });
    add(`SSRF via /api/influx/test: ${name}`, !wasHit() && r.status >= 400, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  }
  srv.close();

  // 6. Query injection: a mapping with quotes and Flux interpolation is stored as data, not run (checked by the unit
  // tests against real InfluxDB servers); here, that it is accepted only as plain names and control characters are refused.
  const evil = await request('POST', '/api/influx/mapping', { body: { mapping: [{ metric: 'x\nDROP', measurement: 'W', field: 'value' }] }, headers: xhr, cookie });
  add('a metric name with a newline is refused', evil.status === 400, `HTTP ${evil.status}`);

  await request('POST', '/api/influx/disconnect', { body: {}, headers: xhr, cookie });

  console.log(JSON.stringify(results, null, 2));
  const bad = results.filter(r => r.verdict.startsWith('VULNERABLE'));
  console.error(`\n=== influx: ${results.length} checks, ${bad.length} VULNERABLE ===`);
  for (const r of results) console.error(`  [${r.verdict}] ${r.scenario} (${r.detail})`);
  process.exit(bad.length);
})().catch(e => { console.error(e); process.exit(255); });
