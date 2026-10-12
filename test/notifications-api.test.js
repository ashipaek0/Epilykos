'use strict';

/**
 * /api/notifications routes + end-to-end delivery against a scratch DB:
 * secret masking and encryption at rest, input validation, push device
 * registration, cleanup cascades, metric/event rules reaching a channel,
 * quiet hours and the source offline/online events.
 *
 * Isolation: chdir into a mkdtemp scratch dir (DB_PATH is CWD-relative) and
 * point ENC_KEY_FILE there. Channel sends are stubbed — no network.
 *
 * Run: node --test test/notifications-api.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-notifications-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'encryption-key');

const express = require('express');
const { initializeDatabase, getDb, getConfig } = require('../modules/database');
initializeDatabase();
const notifications = require('../modules/notifications');
const { CHANNEL_TYPES } = require('../modules/notifications/dispatcher');
const { onEvent } = require('../modules/notifications/events');
const store = require('../modules/notifications/store');

// Built at runtime so no file holds a token-shaped string (secret scanners).
const fakeToken = (botId = 123456) => `${botId}:${'x'.repeat(35)}`;

const sent = [];
for (const type of ['telegram', 'discord', 'ntfy']) {
  CHANNEL_TYPES[type].send = async (config, msg) => { sent.push({ type, config, msg }); };
}
// Saving a Telegram channel asks Telegram for the chat; keep tests offline.
CHANNEL_TYPES.telegram.resolveChat = async (config) => (String(config.chat_id) === '1234567890'
  ? { chat_id: '-1001234567890', title: 'Epilykos', type: 'channel', changed: true }
  : { chat_id: String(config.chat_id), changed: false });

let server, base;
before(async () => {
  notifications.init();
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', require('../modules/notifications/routes').createRouter());
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/notifications`;
});
after(() => { server.close(); });

async function call(method, p, body) {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const settle = () => new Promise(r => setTimeout(r, 20));

const TOKEN = fakeToken();
let tg, push;

test('channel secrets are masked in responses and encrypted at rest', async () => {
  assert.strictEqual((await call('POST', '/channels', { type: 'telegram', name: 'Me', config: { bot_token: 'bad', chat_id: '1' } })).status, 400);
  const r = await call('POST', '/channels', { type: 'telegram', name: 'Me', config: { bot_token: TOKEN, chat_id: '42' } });
  assert.strictEqual(r.status, 200);
  tg = r.body;
  assert.strictEqual(tg.config.bot_token, '');
  assert.strictEqual(tg.config.has_bot_token, true);
  const raw = getDb().prepare("SELECT value FROM config WHERE key = 'notification_channels'").get().value;
  assert.ok(!raw.includes(TOKEN), 'token not stored in plaintext');
  assert.ok(raw.includes('$enc1$'));
  assert.ok(getConfig('notification_channels').includes(TOKEN), 'decrypts on read');

  // Saving the form back with the secret left empty keeps it.
  const u = await call('PUT', `/channels/${tg.id}`, { name: 'Me', config: { bot_token: '', chat_id: '43', has_bot_token: true } });
  assert.strictEqual(u.status, 200);
  const stored = store.getChannels().find(c => c.id === tg.id);
  assert.strictEqual(stored.config.bot_token, TOKEN);
  assert.strictEqual(stored.config.chat_id, '43');
  assert.ok(!('has_bot_token' in stored.config));
  assert.strictEqual((await call('GET', '/state')).body.channels[0].config.bot_token, '');
});

test('rule validation', async () => {
  assert.match((await call('POST', '/rules', { kind: 'metric', name: 'x', metric: 'Battery SOC', operator: 'lt', value: 20, channels: [] })).body.error, /channel/);
  assert.match((await call('POST', '/rules', { kind: 'metric', name: 'x', metric: 'Battery SOC', operator: 'lt', value: 'abc', channels: [tg.id] })).body.error, /number/);
  assert.match((await call('POST', '/rules', { kind: 'event', name: 'x', event: 'bad event!', channels: [tg.id] })).body.error, /event/);
  const ok = await call('POST', '/rules', { kind: 'metric', name: 'Battery low', metric: 'Battery SOC', operator: 'lt', value: '20', for_s: 0, repeat_s: 60, channels: [tg.id, 'ch_gone'] });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.value, 20);
  assert.strictEqual(ok.body.repeat_s, 300, 'repeat is at least 5 minutes');
  assert.deepStrictEqual(ok.body.channels, [tg.id], 'unknown channels dropped');
  const txt = await call('POST', '/rules', { kind: 'metric', name: 'Grid text', metric: 'Grid Status', operator: 'eq', value: 'off', channels: [tg.id] });
  assert.strictEqual(txt.body.value, 'off');
});

test('push device registration: auto channel, no secrets back, iPhone label', async () => {
  const bad = await call('POST', '/devices', { subscription: { endpoint: 'https://127.0.0.1/x', keys: { p256dh: 'p', auth: 'a' } } });
  assert.strictEqual(bad.status, 400, 'private endpoint refused');
  const r = await call('POST', '/devices', { subscription: { endpoint: 'https://8.8.8.8/push/1', keys: { p256dh: 'p', auth: 'secret-auth' } } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.device.label, 'iPhone · Safari');
  assert.ok(r.body.channel && r.body.channel.config.devices === 'all');
  push = r.body.channel;
  const r2 = await call('POST', '/devices', { subscription: { endpoint: 'https://8.8.8.8/push/2', keys: { p256dh: 'p', auth: 'b' } }, label: 'Tablet' });
  assert.strictEqual(r2.body.channel, null, 'only the first device adds a channel');
  const again = await call('POST', '/devices', { subscription: { endpoint: 'https://8.8.8.8/push/1', keys: { p256dh: 'p2', auth: 'c' } }, label: 'Phone' });
  assert.strictEqual(again.body.device.id, r.body.device.id, 're-subscribing updates in place');
  const state = (await call('GET', '/state')).body;
  assert.strictEqual(state.devices.length, 2);
  const json = JSON.stringify(state.devices);
  assert.ok(!json.includes('push/1') && !json.includes('p256dh') && !json.includes('auth'));
  assert.match(state.devices[0].endpoint_hash, /^[0-9a-f]{64}$/);
  assert.ok(state.vapidPublicKey.length > 40);
  assert.ok(!getDb().prepare("SELECT value FROM config WHERE key = 'notification_vapid'").get().value.includes(store.getVapid().privateKey), 'VAPID private key encrypted');

  // A channel aimed at one device loses it when the device is removed.
  const one = await call('POST', '/channels', { type: 'webpush', name: 'Tablet only', config: { devices: [r2.body.device.id] } });
  assert.strictEqual(one.status, 200);
  await call('DELETE', `/devices/${r2.body.device.id}`);
  assert.deepStrictEqual(store.getChannels().find(c => c.id === one.body.id).config.devices, []);
  await call('DELETE', `/channels/${one.body.id}`);
});

test('a metric rule reaches its channel and is logged', async () => {
  sent.length = 0;
  getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('Battery SOC', 12, Math.floor(Date.now() / 1000), '%');
  const hits = notifications.evaluateMetrics();
  assert.strictEqual(hits.length, 1);
  await settle();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].config.bot_token, TOKEN, 'channel gets the decrypted token');
  assert.strictEqual(sent[0].msg.title, 'Battery low');
  assert.match(sent[0].msg.body, /Battery SOC is below 20 %: now 12 %/);
  const log = (await call('GET', '/log')).body;
  assert.strictEqual(log[0].status, 'sent');
  assert.strictEqual(log[0].channel_name, 'Me');
});

test('event rules, quiet hours and critical bypass', async () => {
  const r = await call('POST', '/rules', { kind: 'event', name: 'Grid down', event: 'grid.*', channels: [tg.id] });
  assert.strictEqual(r.body.severity, '', 'event rules inherit severity by default');
  await call('PUT', '/settings', { enabled: true, quiet_hours: { enabled: true, start: '00:00', end: '23:59' } });
  sent.length = 0;
  notifications.emitEvent('grid.on', { message: 'Grid power is back after 5 min off.' });
  await settle();
  assert.strictEqual(sent.length, 0, 'info held back by quiet hours');
  assert.strictEqual((await call('GET', '/log')).body[0].status, 'quiet');
  notifications.emitEvent('grid.off', { message: 'Grid power went off.' });
  await settle();
  assert.strictEqual(sent.length, 1, 'critical goes through');
  assert.strictEqual(sent[0].msg.severity, 'critical');
  await call('PUT', '/settings', { enabled: false, quiet_hours: { enabled: false } });
  notifications.emitEvent('grid.off', { message: 'again' });
  await settle();
  assert.strictEqual(sent.length, 1, 'master switch off');
  await call('PUT', '/settings', { enabled: true, quiet_hours: { enabled: false } });
});

test('source health raises offline after 3 failures and online once', () => {
  const seen = [];
  const off = onEvent(e => { if (e.type.startsWith('source.')) seen.push(e.type + ':' + e.subject); });
  notifications.noteSourceResult('modbus', false, new Error('timeout'));
  notifications.noteSourceResult('modbus', false, new Error('timeout'));
  assert.deepStrictEqual(seen, []);
  notifications.noteSourceResult('modbus', false, new Error('timeout'));
  notifications.noteSourceResult('modbus', false, new Error('timeout'));
  assert.deepStrictEqual(seen, ['source.offline:modbus']);
  notifications.noteSourceResult('modbus', true);
  notifications.noteSourceResult('modbus', true);
  assert.deepStrictEqual(seen, ['source.offline:modbus', 'source.online:modbus']);
  off();
});

test('deleting a channel removes it from rules; test endpoint uses unsaved edits', async () => {
  sent.length = 0;
  const t = await call('POST', '/channels/test', { id: tg.id, type: 'telegram', name: 'Me', config: { bot_token: '', chat_id: '99' } });
  assert.strictEqual(t.status, 200);
  assert.strictEqual(sent[0].config.chat_id, '99');
  assert.strictEqual(sent[0].config.bot_token, TOKEN);
  await call('DELETE', `/channels/${tg.id}`);
  assert.ok(store.getRules().every(r => !r.channels.includes(tg.id)));
  assert.ok(store.getChannels().some(c => c.id === push.id));
});

test('on/off PATCH works even for a rule left without channels', async () => {
  const list = store.getRules();
  list.push({ id: 'orphan', kind: 'event', name: 'Orphan', enabled: true, event: 'grid.off', channels: [] });
  store.saveRules(list);
  const r = await call('PATCH', '/rules/orphan', { enabled: false });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.getRules().find(x => x.id === 'orphan').enabled, false);
  const c = await call('PATCH', `/channels/${push.id}`, { enabled: false });
  assert.strictEqual(c.body.enabled, false);
  assert.strictEqual((await call('PATCH', '/rules/nope', { enabled: true })).status, 404);
});

test('settings PUT changes only what was sent', async () => {
  await call('PUT', '/settings', { enabled: true, quiet_hours: { enabled: true, start: '23:00', end: '06:00' }, base_url: 'https://e.example' });
  const r = await call('PUT', '/settings', { enabled: false });
  assert.deepStrictEqual(r.body.quiet_hours, { enabled: true, start: '23:00', end: '06:00' });
  assert.strictEqual(r.body.base_url, 'https://e.example');
  await call('PUT', '/settings', { enabled: true, quiet_hours: { enabled: false }, base_url: '' });
});

test('an expired device is dropped from the channels that listed it', () => {
  store.saveDevices([{ id: 'dx', label: 'Old', endpoint: 'https://8.8.8.8/x', keys: {} }]);
  store.saveChannels([...store.getChannels(), { id: 'chx', type: 'webpush', name: 'Old only', enabled: true, config: { devices: ['dx'] } }]);
  store.removeDevice('dx');
  assert.deepStrictEqual(store.getChannels().find(c => c.id === 'chx').config.devices, []);
  assert.ok(!store.getDevices().some(d => d.id === 'dx'));
});

test('a refused send (4xx) is not retried; 5xx is', async () => {
  const { sendToChannel } = require('../modules/notifications/dispatcher');
  const real = CHANNEL_TYPES.ntfy.send;
  let calls = 0;
  CHANNEL_TYPES.ntfy.send = async () => { calls++; throw Object.assign(new Error('ntfy 403'), { permanent: true }); };
  const r = await sendToChannel({ type: 'ntfy', config: { topic: 't' } }, { title: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls, 1);
  CHANNEL_TYPES.ntfy.send = real;
  const { httpError } = require('../modules/notifications/channels/http');
  assert.strictEqual((await httpError('X', { status: 401, json: async () => ({}) })).permanent, true);
  assert.strictEqual((await httpError('X', { status: 429, json: async () => ({}) })).permanent, false);
  assert.strictEqual((await httpError('X', { status: 503, json: async () => ({}) })).permanent, false);
});

test('saving a Telegram channel with an app-style channel ID stores the -100 form', async () => {
  const r = await call('POST', '/channels', { type: 'telegram', name: 'Chan', config: { bot_token: TOKEN, chat_id: '1234567890' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.config.chat_id, '-1001234567890');
  assert.match(r.body.note, /Using -1001234567890 for Epilykos/);
  assert.strictEqual(store.getChannels().find(c => c.id === r.body.id).config.chat_id, '-1001234567890');
});
