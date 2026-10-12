'use strict';

/**
 * Notification rule engine, event matching, message text, quiet hours and
 * the channel request builders (pure — no DB, no network).
 *
 * Run: node --test test/notifications-rules.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const rules = require('../modules/notifications/rules');
const { eventMatches, emitEvent, onEvent } = require('../modules/notifications/events');
const { isQuietNow, parseClock } = require('../modules/notifications/dispatcher');
const telegram = require('../modules/notifications/channels/telegram');
const discord = require('../modules/notifications/channels/discord');
const ntfy = require('../modules/notifications/channels/ntfy');
const webpush = require('../modules/notifications/channels/webpush');

// Built at runtime so no file holds a token-shaped string (secret scanners).
const fakeToken = (botId = 123456) => `${botId}:${'x'.repeat(35)}`;

const T0 = 1_800_000_000;
const row = (value, ts = T0, extra = {}) => ({ value: typeof value === 'number' ? value : null, value_text: typeof value === 'string' ? value : null, unit: '%', timestamp: ts, ...extra });
const rows = (name, r) => new Map([[name, r]]);

function socRule(extra = {}) {
  return { id: 'r1', kind: 'metric', enabled: true, name: 'Battery low', metric: 'Battery SOC', operator: 'lt', value: 20, for_s: 0, hysteresis: 0, cooldown_s: 0, notify_resolved: true, channels: ['c'], ...extra };
}

test('threshold fires once, then resolves', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule();
  assert.deepStrictEqual(ev.evaluate([r], rows('Battery SOC', row(50)), T0), []);
  const fire = ev.evaluate([r], rows('Battery SOC', row(15)), T0 + 30);
  assert.strictEqual(fire.length, 1);
  assert.strictEqual(fire[0].transition, 'fire');
  assert.deepStrictEqual(ev.evaluate([r], rows('Battery SOC', row(12)), T0 + 60), [], 'no repeat while still low');
  const res = ev.evaluate([r], rows('Battery SOC', row(30)), T0 + 90);
  assert.strictEqual(res[0].transition, 'resolve');
});

test('for_s waits for the condition to hold, and a blip resets it', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ for_s: 300 });
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(15)), T0).length, 0);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(25)), T0 + 120).length, 0, 'blip above resets the wait');
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(15)), T0 + 150).length, 0);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(15)), T0 + 400).length, 0, 'only 250s since the reset');
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(15)), T0 + 460)[0].transition, 'fire');
});

test('hysteresis holds a firing rule until the margin is cleared', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ hysteresis: 5 });
  ev.evaluate([r], rows('Battery SOC', row(19)), T0);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(22)), T0 + 30).length, 0, '22 is inside the margin');
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(26)), T0 + 60)[0].transition, 'resolve');
});

test('missing data never resolves a firing rule', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule();
  ev.evaluate([r], rows('Battery SOC', row(10)), T0);
  assert.strictEqual(ev.evaluate([r], new Map(), T0 + 30).length, 0);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(30)), T0 + 60)[0].transition, 'resolve');
});

test('cooldown silences a quick re-fire and its resolve', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ cooldown_s: 600 });
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(10)), T0).length, 1);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(30)), T0 + 30)[0].transition, 'resolve');
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(10)), T0 + 60).length, 0, 'inside cooldown');
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(30)), T0 + 90).length, 0, 'silent fire → silent resolve');
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(10)), T0 + 700).length, 1, 'after cooldown');
});

test('repeat_s re-notifies while active', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ repeat_s: 600 });
  ev.evaluate([r], rows('Battery SOC', row(10)), T0);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(10)), T0 + 300).length, 0);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row(10)), T0 + 600)[0].transition, 'repeat');
});

test('eq works on text metrics (grid status off)', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ metric: 'Grid Status', operator: 'eq', value: 'OFF' });
  assert.strictEqual(ev.evaluate([r], rows('Grid Status', row('on')), T0).length, 0);
  assert.strictEqual(ev.evaluate([r], rows('Grid Status', row('off')), T0 + 30)[0].transition, 'fire');
});

test('numeric operators ignore text values instead of guessing', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ operator: 'gt', value: 5 });
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row('unavailable')), T0).length, 0);
  assert.strictEqual(ev.evaluate([r], rows('Battery SOC', row('12')), T0 + 30).length, 1, 'numeric text counts as a number');
});

test('changes fires on each new value, not the first reading', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ metric: 'Inverter Mode', operator: 'changes', value: '' });
  const mode = (v) => rows('Inverter Mode', row(v, T0, { unit: null }));
  assert.strictEqual(ev.evaluate([r], mode('Line'), T0).length, 0);
  assert.strictEqual(ev.evaluate([r], mode('line'), T0 + 30).length, 0, 'case alone is not a change');
  const hit = ev.evaluate([r], mode('Battery'), T0 + 60);
  assert.strictEqual(hit[0].transition, 'change');
  assert.strictEqual(rules.metricMessage(hit[0], T0 + 60).body, 'Inverter Mode changed from Line to Battery.');
});

test('stale fires when a metric stops updating and resolves when it updates', () => {
  const ev = rules.createMetricEvaluator();
  const r = socRule({ metric: 'PV Power', operator: 'stale', value: 10 });
  assert.strictEqual(ev.evaluate([r], rows('PV Power', row(100, T0)), T0 + 300).length, 0);
  const hit = ev.evaluate([r], rows('PV Power', row(100, T0)), T0 + 900);
  assert.strictEqual(hit[0].transition, 'fire');
  assert.match(rules.metricMessage(hit[0], T0 + 900).body, /has not updated for 15 min/);
  assert.strictEqual(ev.evaluate([r], rows('PV Power', row(120, T0 + 930)), T0 + 930)[0].transition, 'resolve');
});

test('editing a rule resets its state; disabled rules are skipped', () => {
  const ev = rules.createMetricEvaluator();
  ev.evaluate([socRule()], rows('Battery SOC', row(10)), T0);
  assert.strictEqual(ev.evaluate([socRule({ value: 15 })], rows('Battery SOC', row(10)), T0 + 30).length, 1, 'new threshold = new rule');
  assert.strictEqual(ev.evaluate([socRule({ id: 'r2', enabled: false })], rows('Battery SOC', row(10)), T0 + 60).length, 0);
});

test('metric message text', () => {
  const r = socRule({ for_s: 300 });
  const m = rules.metricMessage({ rule: r, transition: 'fire', reading: 15, row: row(15) }, T0);
  assert.strictEqual(m.title, 'Battery low');
  assert.strictEqual(m.body, 'Battery SOC is below 20 %: now 15 % for 5 min.');
  const custom = rules.metricMessage({ rule: { ...r, message: 'SOC {value} (limit {threshold})' }, transition: 'fire', reading: 15, row: row(15) }, T0);
  assert.strictEqual(custom.body, 'SOC 15 % (limit 20 %)');
  assert.strictEqual(rules.metricMessage({ rule: r, transition: 'resolve', reading: 30, row: row(30) }, T0).title, 'Resolved: Battery low');
});

test('event wildcards and subject filter', () => {
  assert.ok(eventMatches('source.*', 'source.offline'));
  assert.ok(eventMatches('*', 'grid.off'));
  assert.ok(eventMatches('grid.off', 'grid.off'));
  assert.ok(!eventMatches('grid.off', 'grid.on'));
  assert.ok(!eventMatches('source.*', 'sources.x'));
  const list = [
    { id: 'a', kind: 'event', enabled: true, event: 'source.*', cooldown_s: 600 },
    { id: 'b', kind: 'event', enabled: true, event: 'source.offline', subject: 'Modbus' },
    { id: 'c', kind: 'event', enabled: false, event: '*' },
  ];
  const sent = new Map();
  const ids = (ev, t) => rules.matchEventRules(list, ev, t, sent).map(r => r.id);
  assert.deepStrictEqual(ids({ type: 'source.offline', subject: 'modbus' }, T0), ['a', 'b']);
  assert.deepStrictEqual(ids({ type: 'source.offline', subject: 'modbus' }, T0 + 60), ['b'], 'a is cooling down for modbus');
  assert.deepStrictEqual(ids({ type: 'source.offline', subject: 'tuya' }, T0 + 60), ['a'], 'cooldown is per subject');
});

test('emitEvent fills defaults from the catalog', () => {
  let got;
  const off = onEvent(e => { got = e; });
  emitEvent('grid.off', { message: 'x' });
  off();
  assert.strictEqual(got.severity, 'critical');
  assert.strictEqual(got.title, 'Grid outage started');
  assert.ok(got.timestamp > 0);
});

test('quiet hours, including windows across midnight', () => {
  const at = (h, m) => { const d = new Date(2026, 0, 1, h, m); return d; };
  const s = { quiet_hours: { enabled: true, start: '22:00', end: '07:00' } };
  assert.ok(isQuietNow(s, at(23, 0)));
  assert.ok(isQuietNow(s, at(6, 59)));
  assert.ok(!isQuietNow(s, at(7, 0)));
  assert.ok(!isQuietNow(s, at(12, 0)));
  assert.ok(isQuietNow({ quiet_hours: { enabled: true, start: '13:00', end: '14:00' } }, at(13, 30)));
  assert.ok(!isQuietNow({ quiet_hours: { enabled: false, start: '00:00', end: '23:59' } }, at(12, 0)));
  assert.strictEqual(parseClock('25:00'), null);
});

const MSG = { title: 'Grid <off>', body: 'Power & lights', severity: 'critical', timestamp: T0, url: 'https://energy.example.com/' };

test('telegram request: HTML-escaped, silent for info', async () => {
  const cfg = { bot_token: fakeToken(), chat_id: '-1001' };
  const { url, body } = telegram.buildRequest(cfg, MSG);
  assert.strictEqual(url, `https://api.telegram.org/bot${fakeToken()}/sendMessage`);
  assert.match(body.text, /<b>Grid &lt;off&gt;<\/b>\nPower &amp; lights/);
  assert.strictEqual(body.disable_notification, false);
  assert.strictEqual(telegram.buildRequest(cfg, { ...MSG, severity: 'info' }).body.disable_notification, true);
  assert.ok(telegram.validate({ bot_token: 'nope', chat_id: '1' }));
  let called;
  await telegram.send(cfg, MSG, { fetch: async (u, init) => { called = { u, init }; return { ok: true }; } });
  assert.strictEqual(JSON.parse(called.init.body).chat_id, '-1001');
  await assert.rejects(telegram.send(cfg, MSG, { fetch: async () => ({ ok: false, status: 400, json: async () => ({ description: 'chat not found' }) }) }), /chat not found/);
});

test('telegram findChats lists unique chats', async () => {
  const chats = await telegram.findChats(fakeToken(), { fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: [
    { message: { chat: { id: 42, type: 'private', first_name: 'Ada' } } },
    { message: { chat: { id: 42, type: 'private', first_name: 'Ada' } } },
    { my_chat_member: { chat: { id: -100, type: 'group', title: 'Home' } } },
  ] }) }) });
  assert.deepStrictEqual(chats, [{ id: '42', type: 'private', name: 'Ada' }, { id: '-100', type: 'group', name: 'Home' }]);
});

test('discord request: embed colour, @here only when asked and critical', () => {
  const cfg = { webhook_url: 'https://discord.com/api/webhooks/123/abc-DEF' };
  assert.strictEqual(discord.validate(cfg), null);
  assert.ok(discord.validate({ webhook_url: 'https://evil.example/api/webhooks/1/x' }));
  const { body } = discord.buildRequest(cfg, MSG);
  assert.strictEqual(body.embeds[0].color, 0xdc2626);
  assert.strictEqual(body.embeds[0].url, MSG.url);
  assert.strictEqual(body.content, undefined);
  assert.deepStrictEqual(body.allowed_mentions, { parse: [] });
  assert.strictEqual(discord.buildRequest({ ...cfg, mention_here: true }, MSG).body.content, '@here');
  assert.strictEqual(discord.buildRequest({ ...cfg, mention_here: true }, { ...MSG, severity: 'info' }).body.content, undefined);
});

test('ntfy request: JSON publish with priority, click and token', () => {
  const { url, headers, body } = ntfy.buildRequest({ server_url: 'https://ntfy.example.com/', topic: 'home-energy', token: 'tk_1' }, MSG);
  assert.strictEqual(url, 'https://ntfy.example.com/');
  assert.strictEqual(headers.Authorization, 'Bearer tk_1');
  assert.deepStrictEqual({ topic: body.topic, priority: body.priority, click: body.click }, { topic: 'home-energy', priority: 5, click: MSG.url });
  assert.strictEqual(ntfy.buildRequest({ topic: 't' }, MSG).url, 'https://ntfy.sh/');
  assert.ok(ntfy.validate({ topic: 'has space' }));
});

test('webpush sends to the chosen devices and drops expired ones', async () => {
  const devices = [
    { id: 'd1', label: 'Phone', endpoint: 'https://push.example/1', keys: {} },
    { id: 'd2', label: 'Tablet', endpoint: 'https://push.example/2', keys: {} },
    { id: 'd3', label: 'Old', endpoint: 'https://push.example/3', keys: {} },
  ];
  const sentTo = [], removed = [];
  const deps = {
    getDevices: () => devices,
    removeDevice: id => removed.push(id),
    vapid: { subject: 'https://x', publicKey: 'p', privateKey: 'k' },
    sendNotification: async (sub, payload, opts) => {
      if (sub.endpoint.endsWith('/3')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      sentTo.push(sub.endpoint);
      assert.strictEqual(JSON.parse(payload).title, MSG.title);
      assert.strictEqual(opts.urgency, 'high');
    },
  };
  const r = await webpush.send({ devices: ['d1', 'd3'] }, MSG, deps);
  assert.deepStrictEqual(sentTo, ['https://push.example/1']);
  assert.deepStrictEqual(removed, ['d3']);
  assert.strictEqual(r.delivered, 1);
  sentTo.length = 0;
  await webpush.send({ devices: 'all' }, MSG, deps);
  assert.strictEqual(sentTo.length, 2);
  await assert.rejects(webpush.send({ devices: ['d3'] }, MSG, deps), /expired/);
  await assert.rejects(webpush.send({ devices: ['nope'] }, MSG, deps), /No subscribed devices/);
});

test("telegram: the bot's own ID is refused as a chat ID; chat not found says what to do", async () => {
  const token = fakeToken(1234567890);
  assert.match(telegram.validate({ bot_token: token, chat_id: '1234567890' }), /bot's own ID/);
  assert.strictEqual(telegram.validate({ bot_token: token, chat_id: '123456789' }), null);
  await assert.rejects(
    telegram.send({ bot_token: token, chat_id: '123456789' }, MSG, { fetch: async () => ({ ok: false, status: 400, json: async () => ({ description: 'Bad Request: chat not found' }) }) }),
    (e) => { assert.match(e.message, /add the bot as an admin that can post messages.*press Start\. Then use Find chat/); assert.strictEqual(e.permanent, true); return true; });
});

test('telegram: resolveChat finds a channel by its app ID (adds -100)', async () => {
  const token = fakeToken(1111111111);
  const asked = [];
  const fetch = async (url, init) => {
    const id = JSON.parse(init.body).chat_id;
    asked.push(id);
    if (id === '-1001234567890') return { ok: true, json: async () => ({ ok: true, result: { id: -1001234567890, type: 'channel', title: 'Epilykos' } }) };
    return { ok: false, status: 400, json: async () => ({ description: 'Bad Request: chat not found' }) };
  };
  const r = await telegram.resolveChat({ bot_token: token, chat_id: '1234567890' }, { fetch });
  assert.deepStrictEqual(r, { chat_id: '-1001234567890', title: 'Epilykos', type: 'channel', changed: true });
  assert.deepStrictEqual(asked, ['1234567890', '-1001234567890']);
  await assert.rejects(telegram.resolveChat({ bot_token: token, chat_id: '-100123' }, { fetch }), /admin that can post/);
  // A bad token (401) is not about the ID: no -100 guess, error passes through.
  await assert.rejects(telegram.resolveChat({ bot_token: token, chat_id: '5' }, { fetch: async () => ({ ok: false, status: 401, json: async () => ({ description: 'Unauthorized' }) }) }), /401/);
});

test('telegram: a send to an app-style channel ID retries with -100', async () => {
  const token = fakeToken(1111111111);
  const ids = [];
  await telegram.send({ bot_token: token, chat_id: '1234567890' }, MSG, { fetch: async (url, init) => {
    const id = JSON.parse(init.body).chat_id; ids.push(id);
    return id.startsWith('-100') ? { ok: true } : { ok: false, status: 400, json: async () => ({ description: 'Bad Request: chat not found' }) };
  } });
  assert.deepStrictEqual(ids, ['1234567890', '-1001234567890']);
});

test('telegram: Find chat asks for channel updates too', async () => {
  let asked = '';
  const chats = await telegram.findChats(fakeToken(1111111111), { fetch: async (url) => { asked = url; return { ok: true, json: async () => ({ ok: true, result: [
    { my_chat_member: { chat: { id: -1001234567890, type: 'channel', title: 'Epilykos' } } },
  ] }) }; } });
  assert.match(decodeURIComponent(asked), /allowed_updates=\["message","channel_post","my_chat_member"\]/);
  assert.deepStrictEqual(chats, [{ id: '-1001234567890', type: 'channel', name: 'Epilykos' }]);
});
