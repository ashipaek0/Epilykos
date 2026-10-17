'use strict';
/**
 * test/system-actions.test.js — Settings → System on EpilykosOS (C-HOST-001).
 *
 * routes/system.js forwards exactly the named actions to the host interface
 * (epilykos-hostd) over its Unix socket, relays refusals as 400s, reports
 * "not an appliance" when the socket is absent, and only passes the fields
 * each action needs. A fake host socket stands in for epilykos-hostd.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-host-'));
const sock = path.join(dir, 'host.sock');
const seen = [];
const server = net.createServer(conn => {
  let buf = '';
  conn.on('data', d => {
    buf += d;
    if (!buf.includes('\n')) return;
    const req = JSON.parse(buf.slice(0, buf.indexOf('\n')));
    seen.push(req);
    let reply;
    if (req.action === 'status') reply = { ok: true, appliance: true, os_version: 'v0.6.0', wifi_setup_until: 0, port: 3000, ssh: { enabled: false, password_set: false, keys: [], user: 'epilykos' } };
    else if (req.action === 'set_port' && req.port === 22) reply = { ok: false, error: 'the port must be 80 or between 1024 and 65535' };
    else if (req.action === 'set_port') reply = { ok: true, port: Number(req.port) };
    else if (req.action === 'ssh_set_password' && req.password.length < 8) reply = { ok: false, error: 'the SSH password must be 8 to 128 characters' };
    else if (req.action === 'wifi_setup') reply = { ok: true, wifi_setup_until: 1234 };
    else reply = { ok: true, ssh: { enabled: true, password_set: true, keys: [], user: 'epilykos' } };
    conn.end(JSON.stringify(reply) + '\n');
  });
});

const router = require('../routes/system');
const hostActions = require('../modules/hostActions');

function route(method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} exists`);
  return layer.route.stack.map(s => s.handle);
}
async function call(method, routePath, body) {
  let status = 200, data;
  const res = { status(code) { status = code; return this; }, json(value) { data = value; return this; } };
  const req = { body: body || {} };
  for (const handle of route(method, routePath)) {
    let nextCalled = false;
    await handle(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { status, data };
}

(async () => {
  delete process.env.EPILYKOS_HOST_SOCKET;
  let r = await call('get', '/');
  assert.deepEqual(r.data, { appliance: false });
  r = await call('post', '/restart');
  assert.equal(r.status, 404);
  console.log('ok - not on EpilykosOS: no appliance, actions 404, nothing sent');

  await new Promise(res => server.listen(sock, res));
  process.env.EPILYKOS_HOST_SOCKET = sock;
  assert.equal(hostActions.available(), true);
  r = await call('get', '/');
  assert.equal(r.data.appliance, true);
  assert.equal(r.data.ssh.user, 'epilykos');
  assert.equal(r.data.os_version, 'v0.6.0');
  assert.equal(r.data.port, 3000);
  console.log('ok - on EpilykosOS: status relayed from the host');

  const cases = [
    ['/timezone', {timezone:'Africa/Lagos', restart:false, evil:1}, {action:'set_timezone',timezone:'Africa/Lagos',restart:false}],
    ['/clock', {epoch:1700000000, command:'reboot'}, {action:'set_clock',epoch:1700000000}],
    ['/bluetooth/open', {}, {action:'bluetooth_open'}],
    ['/bluetooth/close', {}, {action:'bluetooth_close'}],
    ['/bluetooth/pair', {address:'AA:BB:CC:DD:EE:FF',action:'shutdown'}, {action:'bluetooth_pair',address:'AA:BB:CC:DD:EE:FF'}],
    ['/bluetooth/reply', {id:'request',value:'123456',extra:1}, {action:'bluetooth_reply',id:'request',value:'123456'}],
    ['/bluetooth/remove', {address:'AA:BB:CC:DD:EE:FF'}, {action:'bluetooth_remove',address:'AA:BB:CC:DD:EE:FF'}],
    ['/restart', undefined, { action: 'restart' }],
    ['/shutdown', undefined, { action: 'shutdown' }],
    ['/wifi-setup', undefined, { action: 'wifi_setup' }],
    ['/port', { port: 8080, action: 'shutdown' }, { action: 'set_port', port: 8080 }],
    ['/port', { port: { $gt: 1 } }, { action: 'set_port', port: null }],
    ['/ssh/enable', { evil: 'x' }, { action: 'ssh_enable' }],
    ['/ssh/disable', undefined, { action: 'ssh_disable' }],
    ['/ssh/password', { password: 'long enough', extra: 1 }, { action: 'ssh_set_password', password: 'long enough' }],
    ['/ssh/password/clear', undefined, { action: 'ssh_clear_password' }],
    ['/ssh/keys', { key: 'ssh-ed25519 AAAA x', action: 'shutdown' }, { action: 'ssh_add_key', key: 'ssh-ed25519 AAAA x' }],
    ['/ssh/keys/remove', { fingerprint: 'SHA256:abc' }, { action: 'ssh_remove_key', fingerprint: 'SHA256:abc' }]
  ];
  for (const [p, body, expected] of cases) {
    seen.length = 0;
    r = await call('post', p, body);
    assert.equal(r.status, 200, p);
    assert.equal(r.data.success, true, p);
    assert.deepEqual(seen, [expected], p);
  }
  console.log('ok - each route sends exactly its action and only the fields it needs (a body cannot change the action)');

  r = await call('post', '/wifi-setup');
  assert.equal(r.data.wifi_setup_until, 1234);
  r = await call('post', '/ssh/password', { password: 'short' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /8 to 128/);
  r = await call('post', '/port', { port: 22 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /80 or between 1024 and 65535/);
  r = await call('post', '/port', { port: 8080 });
  assert.equal(r.data.port, 8080);
  console.log('ok - host refusals become 400s with the host\'s message');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  r = await call('post', '/restart');
  assert.equal(r.status, 404);
  process.env.EPILYKOS_HOST_SOCKET = path.join(os.tmpdir(), 'no-such-dir', 'host.sock');
  r = await call('get', '/');
  assert.deepEqual(r.data, { appliance: false });
  console.log('ok - socket gone: treated as not an appliance');

  await assert.rejects(hostActions.call('status', {}, { socket: path.join(os.tmpdir(), 'missing.sock') }), err => err.status === 503);
  console.log('ok - unreachable host: 503');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; server.close(); });
