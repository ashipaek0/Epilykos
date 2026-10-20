'use strict';
/**
 * SSRF attacks: can an authenticated user make the server fetch loopback,
 * the cloud-metadata address, or a chosen internal host, through the
 * URL-fetching features (external REST source test, HA entity fetch)?
 *
 * "Proven" = we watched the actual outbound attempt (or its refusal) in the
 * server's behaviour, not just read the code.
 *
 *   node test/security/03-ssrf.js
 */
const http = require('http');
const { request, login, xhr } = require('./_client');

const results = [];
// A local sink the server would hit IF the guard let a loopback URL through.
function sink(port) {
  return new Promise(resolve => {
    let hit = false;
    const s = http.createServer((req, res) => { hit = true; res.end('SINK-REACHED'); });
    s.listen(port, '127.0.0.1', () => resolve({ srv: s, wasHit: () => hit }));
  });
}

(async () => {
  const cookie = await login();
  const targets = [
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:9777/secret'],
    ['loopback alt (0.0.0.0)', 'http://0.0.0.0:9777/secret'],
    ['loopback decimal', 'http://2130706433:9777/secret'],    // 127.0.0.1
    ['ipv6 loopback', 'http://[::1]:9777/secret'],
    ['file scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://127.0.0.1:9777/_x'],
  ];
  const { srv, wasHit } = await sink(9777);
  for (const [name, url] of targets) {
    const r = await request('POST', '/api/test-external', { body: { url }, headers: xhr, cookie });
    const reached = wasHit();
    const refused = !reached && (r.status >= 400);
    results.push({ attack: 'SSRF via /api/test-external', target: name, url,
      status: r.status, serverFetched: reached,
      response: typeof r.body === 'string' ? r.body.slice(0,80) : JSON.stringify(r.body).slice(0,120),
      verdict: reached ? 'VULNERABLE (server hit loopback sink)' : refused ? 'ok (refused)' : 'ok (not reached)' });
  }
  // Redirect bypass: a public-looking URL that 302s to the metadata IP.
  const redir = await new Promise(res => {
    const s = http.createServer((req, rq) => { rq.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); rq.end(); });
    s.listen(9778, '127.0.0.1', () => res(s));
  });
  {
    // loopback sink again to catch a redirect that lands anywhere local
    const r = await request('POST', '/api/test-external', { body: { url: 'http://127.0.0.1:9778/' }, headers: xhr, cookie });
    results.push({ attack: 'SSRF redirect to metadata', target: 'redirect hop', url: 'http://127.0.0.1:9778 -> 169.254.169.254',
      status: r.status, serverFetched: wasHit(), response: JSON.stringify(r.body).slice(0,120),
      verdict: (r.status >= 400) ? 'ok (first hop blocked)' : 'see status' });
    redir.close();
  }
  srv.close();

  console.log(JSON.stringify(results, null, 2));
  const vulns = results.filter(r => r.verdict.startsWith('VULNERABLE'));
  console.error(`\n=== ssrf: ${results.length} checks, ${vulns.length} VULNERABLE ===`);
  for (const v of vulns) console.error(`  VULN: ${v.target} ${v.url}`);
  process.exit(vulns.length);
})().catch(e => { console.error(e); process.exit(255); });
