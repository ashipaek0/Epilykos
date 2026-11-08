'use strict';
/**
 * Any browser can offer itself as a push device (the toast in
 * public/js/push-prompt.js -> /api/push), signed in or not. A registered
 * device is a possible target only: it receives nothing until a rule lists it
 * (or a push channel the admin set to "all devices" includes it).
 *
 * Offline: the push services and DNS are stubbed, no network.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-pushprompt-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'encryption-key');

const express = require('express');
const { initializeDatabase } = require('../modules/database');
initializeDatabase();
// The registration route checks the push address against DNS: keep it offline.
require('../modules/utils').assertSafeFetchUrl = async () => ({ ok: true });
const notifications = require('../modules/notifications');
const { CHANNEL_TYPES } = require('../modules/notifications/dispatcher');
const store = require('../modules/notifications/store');
const routes = require('../modules/notifications/routes');

const pushed = [];
CHANNEL_TYPES.webpush.send = async (config, msg) => { pushed.push({ devices: config.devices, title: msg.title }); return { delivered: 1, failures: [] }; };

const FCM = n => `https://fcm.googleapis.com/fcm/send/${n}`;
const sub = (endpoint, auth = 'a') => ({ endpoint, keys: { p256dh: 'p', auth } });
const hash = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex');

let publicServer, adminServer, pub, admin;
function serve(mount, router) {
  const app = express(); app.use(express.json()); app.use(mount, router);
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}
async function call(base, method, p, body) {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
before(async () => {
  notifications.init();
  publicServer = await serve('/api/push', routes.createPublicRouter({ limit: 1000 }));
  adminServer = await serve('/api/notifications', routes.createRouter());
  pub = `http://127.0.0.1:${publicServer.address().port}/api/push`;
  admin = `http://127.0.0.1:${adminServer.address().port}/api/notifications`;
});
after(() => { publicServer.close(); adminServer.close(); });

test('the public key is served without signing in', async () => {
  const r = await call(pub, 'GET', '/key');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.publicKey.length > 40);
  assert.ok(!JSON.stringify(r.body).includes(store.getVapid().privateKey));
});

test('a browser registers itself: named from its user agent, no channel, nothing chosen', async () => {
  const r = await call(pub, 'POST', '/register', { subscription: sub(FCM('one')) });
  assert.strictEqual(r.status, 200);
  const devices = store.getDevices();
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].label, 'Linux · Firefox');
  assert.deepStrictEqual(store.getChannels(), [], 'registering from the prompt creates no channel');
  assert.deepStrictEqual(store.getRules(), []);
  assert.deepStrictEqual(pushed, [], 'and nothing is sent');
  // Registering again updates in place.
  await call(pub, 'POST', '/register', { subscription: sub(FCM('one'), 'b') });
  assert.strictEqual(store.getDevices().length, 1);
});

test('only the push services browsers use, over HTTPS, are accepted', async () => {
  for (const endpoint of ['https://8.8.8.8/push/1', 'https://evil.example.com/push', 'http://fcm.googleapis.com/x', 'https://googleapis.com.evil.example/x']) {
    const r = await call(pub, 'POST', '/register', { subscription: sub(endpoint) });
    assert.strictEqual(r.status, 400, endpoint);
  }
  for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/x']) {
    assert.strictEqual((await call(pub, 'POST', '/register', { subscription: sub(endpoint) })).status, 200, endpoint);
  }
  assert.strictEqual((await call(pub, 'POST', '/register', { subscription: { endpoint: FCM('nokeys') } })).status, 400);
  store.saveDevices(store.getDevices().slice(0, 1));
});

test('"known" says whether the server lists a browser, by the hash of its push address', async () => {
  assert.strictEqual((await call(pub, 'POST', '/known', { endpoint_hash: hash(FCM('one')) })).body.known, true);
  assert.strictEqual((await call(pub, 'POST', '/known', { endpoint_hash: hash(FCM('other')) })).body.known, false);
  assert.strictEqual((await call(pub, 'POST', '/known', { endpoint_hash: 'nope' })).body.known, false);
  assert.strictEqual((await call(pub, 'POST', '/known', {})).body.known, false);
});

test('a registered device only receives what a rule lists', async () => {
  const dev = store.getDevices()[0];
  assert.match((await call(admin, 'POST', '/rules', { kind: 'event', name: 'Nowhere', event: 'grid.off', channels: [], devices: [] })).body.error, /channel or device/);
  const rule = await call(admin, 'POST', '/rules', { kind: 'event', name: 'Grid outage', event: 'grid.off', channels: [], devices: [dev.id, 'dev_gone'] });
  assert.strictEqual(rule.status, 200);
  assert.deepStrictEqual(rule.body.devices, [dev.id], 'unknown devices dropped');
  const other = await call(admin, 'POST', '/channels', { type: 'webpush', name: 'Nobody yet', config: { devices: [dev.id] } });
  await call(admin, 'DELETE', `/channels/${other.body.id}`);
  const second = await call(pub, 'POST', '/register', { subscription: sub(FCM('two')) });
  assert.strictEqual(second.status, 200);
  const devTwo = store.getDevices().find(d => d.endpoint === FCM('two'));

  pushed.length = 0;
  const t = await call(admin, 'POST', `/rules/${rule.body.id}/test`);
  assert.strictEqual(t.status, 200);
  assert.deepStrictEqual(pushed.map(p => p.devices), [[dev.id]], 'only the device the rule lists');
  assert.ok(!pushed.some(p => p.devices.includes(devTwo.id)));
  assert.ok(store.getLog(5).some(l => l.channel_name === 'Push devices' && l.status === 'sent'));

  // A device removed from the list is dropped from the rule.
  await call(admin, 'DELETE', `/devices/${dev.id}`);
  assert.deepStrictEqual(store.getRules().find(r => r.id === rule.body.id).devices, []);
  store.saveRules([]);
});

test('a push channel set to "all devices" still includes ones added later', () => {
  const devices = store.getDevices();
  assert.strictEqual(CHANNEL_TYPES.webpush.targets({ devices: 'all' }, devices).length, devices.length);
});

test('the admin route registers the same way and still adds the starter channel once', async () => {
  const r = await call(admin, 'POST', '/devices', { subscription: sub(FCM('admin')), label: 'Desk' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.device.label, 'Desk');
  assert.ok(r.body.channel && r.body.channel.config.devices === 'all');
  assert.strictEqual((await call(admin, 'POST', '/devices', { subscription: sub(FCM('admin2')) })).body.channel, null);
});

test('registration is capped, and limited per address', async () => {
  const list = [], first = store.getDevices().length;
  for (let i = first; i < store.MAX_DEVICES; i++) list.push({ id: 'dev_fill' + i, label: 'x', endpoint: FCM('fill' + i), keys: { p256dh: 'p', auth: 'a' }, user_agent: '', created_at: 1 });
  store.saveDevices([...store.getDevices(), ...list]);
  const full = await call(pub, 'POST', '/register', { subscription: sub(FCM('one-too-many')) });
  assert.strictEqual(full.status, 429);
  assert.match(full.body.error, /Too many devices/);
  assert.strictEqual((await call(pub, 'POST', '/register', { subscription: sub(FCM('fill' + first)) })).status, 200, 'an already registered browser can still refresh');

  const fresh = await serve('/api/push', routes.createPublicRouter());
  const base = `http://127.0.0.1:${fresh.address().port}/api/push`;
  let last;
  for (let i = 0; i < 11; i++) last = await call(base, 'POST', '/register', { subscription: sub(FCM('rate' + i)) });
  assert.strictEqual(last.status, 429, 'the 11th request in an hour is refused');
  fresh.close();
});
