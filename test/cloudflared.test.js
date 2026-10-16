'use strict';
const checks = require('./_checks');
// Cloudflare Tunnel in Settings → Network, against a stand-in for cloudflared:
// the token (or the whole install command) is accepted, kept off the command
// line and encrypted at rest, the public address needs the admin password
// (12+ characters), readiness comes from /ready, and the token never shows in
// the log or the diagnostics file.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-cloudflared-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.SETTINGS_PASSWORD;
process.env.PORT = '3000';
const express = require('express');
const database = require('../modules/database');
database.initializeDatabase();
const { setSettingsPassword } = require('../modules/sessionAuth');
const cloudflared = require('../modules/cloudflared');
const remote = require('../routes/remote');
const logs = require('../routes/logs');

// A token-shaped value built at runtime (secret scanners).
const secret = Buffer.from('s'.repeat(32)).toString('base64');
const TUNNEL = '6ff42ae2-765d-4adf-8112-31c55c1551ef';
const TOKEN = Buffer.from(JSON.stringify({ a: 'a'.repeat(32), t: TUNNEL, s: secret })).toString('base64');

const spawned = [];
let ready = { status: 503, readyConnections: 0 };
cloudflared.setRunnerForTests({
  spawn(bin, args, opts) {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')); };
    spawned.push({ bin, args, env: opts && opts.env, child: c });
    if (args[0] === '--version') setImmediate(() => c.emit('exit', 0));
    return c;
  },
  fetch: async url => { assert.equal(url, `http://${cloudflared.METRICS}/ready`); return { json: async () => ready }; },
});

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, text: data, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  // The token alone, or inside the install commands Cloudflare shows.
  assert.equal(cloudflared.parseToken(TOKEN).tunnelId, TUNNEL);
  assert.equal(cloudflared.parseToken(`sudo cloudflared service install ${TOKEN}`).token, TOKEN);
  assert.equal(cloudflared.parseToken(`docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${TOKEN}\n`).token, TOKEN);
  assert.throws(() => cloudflared.parseToken('hello'), /doesn't look like a Cloudflare tunnel token/);
  assert.throws(() => cloudflared.parseToken(''), /doesn't look like/);
  assert.equal(remote.normalisePublicUrl('energy.example.com'), 'https://energy.example.com');
  assert.equal(remote.normalisePublicUrl('https://Energy.Example.com/'), 'https://energy.example.com');
  assert.equal(remote.normalisePublicUrl(''), null);
  assert.throws(() => remote.normalisePublicUrl('http://energy.example.com'), /public hostname/);
  assert.throws(() => remote.normalisePublicUrl('energy.example.com/dashboard'), /public hostname/);
  console.log('ok - the token is found in what was pasted; the address is a plain https hostname');

  const app = express();
  app.use('/api/remote', remote.router());
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    let r = await request(server, 'GET', '/api/remote/cloudflare');
    assert.equal(r.body.state, 'off'); assert.equal(r.body.port, 3000);

    setSettingsPassword('short');
    r = await request(server, 'POST', '/api/remote/cloudflare/connect', { token: TOKEN, password: 'nope' });
    assert.equal(r.status, 403);
    r = await request(server, 'POST', '/api/remote/cloudflare/connect', { token: TOKEN, password: 'short' });
    assert.equal(r.status, 400); assert.equal(r.body.code, 'weak_password');
    setSettingsPassword('a-long-admin-password');
    r = await request(server, 'POST', '/api/remote/cloudflare/connect', { token: 'garbage', password: 'a-long-admin-password' });
    assert.equal(r.status, 400);
    assert.ok(!spawned.some(s => s.args[0] === 'tunnel'), 'nothing started until all checks pass');

    r = await request(server, 'POST', '/api/remote/cloudflare/connect', { token: `cloudflared service install ${TOKEN}`, publicUrl: 'energy.example.com', password: 'a-long-admin-password' });
    assert.equal(r.status, 200, r.text);
    const run = spawned.find(s => s.args[0] === 'tunnel');
    assert.deepEqual(run.args, ['tunnel', '--no-autoupdate', '--metrics', cloudflared.METRICS, 'run']);
    assert.equal(run.env.TUNNEL_TOKEN, TOKEN, 'the token goes in through the environment');
    assert.ok(!run.args.join(' ').includes(TOKEN), 'never on the command line');
    assert.ok(!r.text.includes(TOKEN) && !r.text.includes(secret), 'never sent back to the page');
    assert.equal(r.body.state, 'connecting'); assert.equal(r.body.tunnelId, TUNNEL);
    assert.equal(r.body.publicUrl, 'https://energy.example.com'); assert.equal(r.body.filledRemoteUrl, true);
    assert.equal(database.getConfig('network_remote_url'), 'https://energy.example.com');
    const stored = database.getDb().prepare("SELECT value FROM config WHERE key = 'cloudflare_tunnel'").get().value;
    assert.ok(!stored.includes(TOKEN), 'encrypted at rest');
    assert.equal(JSON.parse(database.getConfig('cloudflare_tunnel')).token, TOKEN, 'and read back decrypted');

    ready = { status: 200, readyConnections: 4 };
    r = await request(server, 'GET', '/api/remote/cloudflare');
    assert.equal(r.body.state, 'connected'); assert.equal(r.body.connections, 4); assert.match(r.body.urlQr, /^<svg/);
    console.log('ok - connect needs the admin password (12+), keeps the token off the command line and encrypted, and reports readiness');

    // The token never reaches the log page or the diagnostics file.
    const logBuffer = require('../modules/logBuffer');
    logs.init();
    run.child.stderr.emit('data', `2026-10-16T10:00:00Z ERR failed with token ${TOKEN}\n`);
    assert.ok(!logBuffer.asText().includes(TOKEN));
    assert.ok(logs.secretValues().includes(TOKEN));
    assert.equal(logs.redactedConfig().cloudflare_tunnel.token, '[hidden]');
    console.log('ok - the token is hidden in the log and the diagnostics file');

    r = await request(server, 'POST', '/api/remote/cloudflare/disconnect', {});
    assert.equal(r.body.state, 'off');
    assert.ok(run.child.killed, 'cloudflared stopped');
    assert.equal(JSON.parse(database.getConfig('cloudflare_tunnel')).token, undefined, 'token forgotten');
    assert.equal(database.getConfig('network_remote_url'), '', 'the address it filled in is cleared');
    console.log('ok - turning it off stops cloudflared, forgets the token and clears the address it filled in');
  } finally { cloudflared.stop(); server.close(); }

  const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(docker, /FROM cloudflare\/cloudflared:latest AS cloudflared/);
  assert.match(docker, /COPY --from=cloudflared \/usr\/local\/bin\/cloudflared \/usr\/local\/bin\//);
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'docker-build.yml'), 'utf8');
  assert.match(wf, /schedule:\n\s+- cron: '17 3 \* \* 1'/, 'weekly rebuild of the released image');
  console.log('ok - the image carries cloudflared; the released image is rebuilt weekly');
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
