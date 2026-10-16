'use strict';
const checks = require('./_checks');
// Remote access with Tailscale, against a stand-in for the tailscale CLI and
// tailscaled: sign in, HTTPS address (with the enable link when the tailnet
// hasn't turned HTTPS on), Funnel behind the admin password, filling and
// clearing "Address away from home", disconnect.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-tailscale-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.SETTINGS_PASSWORD;
process.env.PORT = '3000';
const express = require('express');
const database = require('../modules/database');
database.initializeDatabase();
const { setSettingsPassword } = require('../modules/sessionAuth');
const tailscale = require('../modules/tailscale');
const remote = require('../routes/remote');

// ── The stand-in ──────────────────────────────────────────────────────────
const ts = { backend: 'NeedsLogin', authUrl: '', https: false, funnelCap: false, serving: false, funnel: false, calls: [], waiting: {} };
function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')); };
  return c;
}
const strip = args => args.filter(a => !a.startsWith('--socket='));
tailscale.setRunnerForTests({
  execFile(bin, args, opts, cb) {
    const a = strip(args); ts.calls.push(a.join(' '));
    setImmediate(() => {
      if (a[0] === 'version') return cb(null, '1.102.5\n', '');
      if (a[0] === 'status') return cb(null, JSON.stringify({
        Version: '1.102.5-t123', BackendState: ts.backend, AuthURL: ts.authUrl, TailscaleIPs: ['100.64.0.7'],
        Self: { DNSName: 'epilykos.tail1234.ts.net.', Online: ts.backend === 'Running', CapMap: { ...(ts.https ? { https: null } : {}), ...(ts.funnelCap ? { funnel: null } : {}) } },
        CurrentTailnet: { Name: 'me@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
      }), '');
      if (a[0] === 'serve' && a[1] === 'status') return cb(null, JSON.stringify(ts.serving ? { TCP: { 443: { HTTPS: true } }, Web: { 'epilykos.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, ...(ts.funnel ? { AllowFunnel: { 'epilykos.tail1234.ts.net:443': true } } : {}) } : {}), '');
      if (a[0] === 'serve' && a[1] === 'reset') { ts.serving = false; ts.funnel = false; return cb(null, '', ''); }
      if (a[0] === 'logout') { ts.backend = 'NeedsLogin'; return cb(null, '', ''); }
      cb(new Error('unexpected ' + a.join(' ')), '', 'unexpected');
    });
  },
  spawn(bin, args) {
    const a = strip(args); ts.calls.push(`${path.basename(bin)} ${a.join(' ')}`);
    const c = child();
    if (bin.endsWith('tailscaled')) {
      fs.mkdirSync(tailscale.DIR, { recursive: true }); fs.writeFileSync(tailscale.SOCKET, '');
      ts.daemon = c; return c;
    }
    setImmediate(() => {
      if (a[0] === 'up') {
        ts.authUrl = 'https://login.tailscale.com/a/abc123';
        c.stdout.emit('data', JSON.stringify({ AuthURL: ts.authUrl, BackendState: 'NeedsLogin' }, null, '\t') + '\n');
        ts.waiting.up = () => { ts.backend = 'Running'; ts.authUrl = ''; c.stdout.emit('data', '{"BackendState":"Running"}\n'); c.emit('exit', 0); };
      } else if (a[0] === 'serve' || a[0] === 'funnel') {
        const isFunnel = a[0] === 'funnel';
        const go = () => { ts.serving = true; if (isFunnel) ts.funnel = true; c.emit('exit', 0); };
        const allowed = ts.https && (!isFunnel || ts.funnelCap);
        if (allowed) return go();
        c.stdout.emit('data', `\nServe is not enabled on your tailnet.\n\n         https://login.tailscale.com/f/${isFunnel ? 'funnel' : 'serve'}?node=n1\n\n`);
        ts.waiting.enable = () => { ts.https = true; if (isFunnel) ts.funnelCap = true; go(); };
      }
    });
    return c;
  },
});

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const tick = () => new Promise(r => setTimeout(r, 30));

(async () => {
  const app = express();
  app.use('/api/remote', remote.router());
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    let r = await request(server, 'GET', '/api/remote/tailscale');
    assert.equal(r.body.state, 'off'); assert.equal(r.body.installed, true);
    assert.ok(!ts.calls.some(c => c.startsWith('tailscaled')), 'nothing runs until it is turned on');

    // Connect: tailscaled in userspace mode, then `up` gives a sign-in link (and a QR code).
    r = await request(server, 'POST', '/api/remote/tailscale/connect', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'needs-login');
    assert.equal(r.body.signInLink, 'https://login.tailscale.com/a/abc123');
    assert.match(r.body.signInQr, /^<svg/);
    assert.ok(ts.calls.some(c => c === `tailscaled --tun=userspace-networking --statedir=${tailscale.DIR}`), ts.calls.join('\n'));
    assert.ok(ts.calls.includes('tailscale up --json --hostname=epilykos'));
    assert.equal(database.getConfig('tailscale_enabled'), 'true');
    console.log('ok - connect starts Tailscale in userspace mode and returns the sign-in link');

    ts.waiting.up(); await tick();
    r = await request(server, 'GET', '/api/remote/tailscale');
    assert.equal(r.body.state, 'running'); assert.equal(r.body.dnsName, 'epilykos.tail1234.ts.net');
    assert.equal(r.body.tailnet, 'me@example.com'); assert.equal(r.body.version, '1.102.5');
    assert.equal(r.body.serving, false); assert.equal(r.body.signInLink, null, 'no stale sign-in link once signed in');

    // HTTPS not enabled on the tailnet yet: the enable link is passed on, then the address appears.
    r = await request(server, 'POST', '/api/remote/tailscale/serve', {});
    assert.equal(r.body.enableLink, 'https://login.tailscale.com/f/serve?node=n1');
    assert.ok(ts.calls.includes('tailscale serve --bg --yes 3000'));
    ts.waiting.enable(); await tick();
    r = await request(server, 'GET', '/api/remote/tailscale');
    assert.equal(r.body.serving, true); assert.equal(r.body.privateUrl, 'https://epilykos.tail1234.ts.net');
    assert.equal(r.body.enableLink, null); assert.match(r.body.urlQr, /^<svg/);
    assert.equal(r.body.filledRemoteUrl, true);
    assert.equal(database.getConfig('network_remote_url'), 'https://epilykos.tail1234.ts.net', 'Address away from home filled in');
    console.log('ok - the HTTPS address (after enabling HTTPS on the tailnet) fills in Address away from home');

    // An address the user set themselves is kept.
    database.setConfig('network_remote_url', 'https://energy.example.com');
    r = await request(server, 'GET', '/api/remote/tailscale');
    assert.equal(database.getConfig('network_remote_url'), 'https://energy.example.com');
    assert.ok(!r.body.filledRemoteUrl);

    // Funnel: password required, 12+ characters.
    setSettingsPassword('short');
    r = await request(server, 'POST', '/api/remote/tailscale/funnel', { on: true });
    assert.equal(r.status, 403);
    r = await request(server, 'POST', '/api/remote/tailscale/funnel', { on: true, password: 'wrong' });
    assert.equal(r.status, 403);
    r = await request(server, 'POST', '/api/remote/tailscale/funnel', { on: true, password: 'short' });
    assert.equal(r.status, 400); assert.equal(r.body.code, 'weak_password');
    assert.ok(!ts.calls.some(c => c.startsWith('tailscale funnel')), 'nothing sent without a strong password');
    setSettingsPassword('a-long-admin-password');
    r = await request(server, 'POST', '/api/remote/tailscale/funnel', { on: true, password: 'a-long-admin-password' });
    assert.equal(r.body.enableLink, 'https://login.tailscale.com/f/funnel?node=n1', 'Funnel not allowed yet: its enable link');
    ts.waiting.enable(); await tick();
    r = await request(server, 'GET', '/api/remote/tailscale');
    assert.equal(r.body.funnel, true);
    r = await request(server, 'POST', '/api/remote/tailscale/funnel', { on: false });
    assert.equal(r.body.funnel, false); assert.equal(r.body.serving, true, 'off closes Funnel, keeps the private address');
    console.log('ok - Funnel needs the admin password (12+ characters); off keeps the private address');

    // Disconnect: logout, stop tailscaled, clear only an address this page filled in.
    database.setConfig('network_remote_url', 'https://epilykos.tail1234.ts.net');
    database.setConfig('tailscale_filled_remote_url', 'https://epilykos.tail1234.ts.net');
    r = await request(server, 'POST', '/api/remote/tailscale/disconnect', {});
    assert.equal(r.body.state, 'off');
    assert.ok(ts.calls.includes("logout"), "logged out of the tailnet");
    assert.ok(ts.daemon.killed, 'tailscaled stopped');
    assert.equal(database.getConfig('tailscale_enabled'), 'false');
    assert.equal(database.getConfig('network_remote_url'), '', 'the filled-in address is cleared');
    console.log('ok - disconnect logs out, stops Tailscale and clears the address it filled in');
  } finally { tailscale.stopDaemon(); server.close(); }

  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /app\.use\('\/api\/remote', isAuthenticated, require\('\.\/routes\/remote'\)\.router\(\)\)/, 'signed-in only');
  const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(docker, /FROM tailscale\/tailscale:stable AS tailscale/);
  assert.match(docker, /COPY --from=tailscale \/usr\/local\/bin\/tailscale \/usr\/local\/bin\/tailscaled \/usr\/local\/bin\//);
  assert.equal(tailscale.hostname('My House!'), 'my-house');
  console.log('ok - behind sign-in; the image carries Tailscale stable');
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
