'use strict';

/**
 * Notifications phase 3–4: persisted rule state, scheduled reports (day
 * summary, forecast with "only below", status), the webhook channel, the
 * forecast.unavailable event wiring and Telegram commands.
 *
 * Isolation: chdir into a mkdtemp scratch dir (DB_PATH is CWD-relative) and
 * point ENC_KEY_FILE there. No network: channel sends and Telegram fetches
 * are stubbed, the forecast is stubbed on the solar module.
 *
 * Run: node --test test/notifications-reports.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-notif-reports-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'encryption-key');

const { initializeDatabase, getDb, setConfig } = require('../modules/database');
initializeDatabase();
const solar = require('../modules/solar');
const notifications = require('../modules/notifications');
const rules = require('../modules/notifications/rules');
const reports = require('../modules/notifications/reports');
const store = require('../modules/notifications/store');
const { CHANNEL_TYPES } = require('../modules/notifications/dispatcher');
const { normalizeRule } = require('../modules/notifications/routes');
const webhook = require('../modules/notifications/channels/webhook');
const bot = require('../modules/notifications/telegramBot');

const sent = [];
CHANNEL_TYPES.telegram.send = async (config, msg) => { sent.push({ config, msg }); };
const TG = { id: 'ch_tg', type: 'telegram', name: 'Me', enabled: true, config: { bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chat_id: '42' } };

before(() => {
  store.saveChannels([TG]);
  notifications.init();
});
after(() => notifications.stop());

const today = reports.dayString(0), tomorrow = reports.dayString(1);
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

test('dueSchedules: time window, weekdays, once a day', () => {
  const r = { id: 's1', kind: 'schedule', enabled: true, time: '21:00', days: [] };
  const date = (h, m) => new Date(2026, 9, 12, h, m); // a Monday
  assert.deepStrictEqual(rules.dueSchedules([r], date(20, 59), {}, '2026-10-12'), []);
  assert.strictEqual(rules.dueSchedules([r], date(21, 0), {}, '2026-10-12').length, 1);
  assert.strictEqual(rules.dueSchedules([r], date(22, 30), {}, '2026-10-12').length, 1, 'catch up within 2 h');
  assert.deepStrictEqual(rules.dueSchedules([r], date(23, 30), {}, '2026-10-12'), [], 'too late, skip the day');
  assert.deepStrictEqual(rules.dueSchedules([r], date(21, 5), { s1: '2026-10-12' }, '2026-10-12'), [], 'already ran');
  assert.deepStrictEqual(rules.dueSchedules([{ ...r, days: [0, 6] }], date(21, 0), {}, '2026-10-12'), [], 'weekends only');
  assert.strictEqual(rules.dueSchedules([{ ...r, days: [1] }], date(21, 0), {}, '2026-10-12').length, 1);
});

test('metric rule state survives a restart (no repeat alert, no lost cooldown)', () => {
  const rule = { id: 'r1', kind: 'metric', enabled: true, name: 'Low', metric: 'SOC', operator: 'lt', value: 20, cooldown_s: 3600, channels: [] };
  const rows = new Map([['SOC', { value: 10, timestamp: 1000, unit: '%' }]]);
  const a = rules.createMetricEvaluator();
  assert.strictEqual(a.evaluate([rule], rows, 1000).length, 1);
  const saved = JSON.parse(JSON.stringify(a.exportState()));
  const b = rules.createMetricEvaluator();
  b.importState(saved);
  assert.strictEqual(b.evaluate([rule], rows, 1030).length, 0, 'still firing after restart: no second alert');
  const c = rules.createMetricEvaluator();
  c.importState({ r1: { ...saved.r1, sig: 'other' } });
  assert.strictEqual(c.evaluate([rule], rows, 1030).length, 1, 'a changed rule starts fresh');
  c.importState({ bad: { phase: 'nonsense' }, worse: null });
  assert.ok(!c.states.has('bad'));
});

test('index persists rule state to config when it changes', () => {
  store.saveRules([{ id: 'rp', kind: 'metric', enabled: true, name: 'Low', metric: 'Battery SOC', operator: 'lt', value: 20, cooldown_s: 0, for_s: 0, channels: [TG.id] }]);
  getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('Battery SOC', 15, Math.floor(Date.now() / 1000), '%');
  notifications.evaluateMetrics();
  assert.strictEqual(store.getState().metric.rp.phase, 'firing');
  store.saveRules([]);
});

test('day summary reads the day totals and grid time', async () => {
  const { start } = reports.dayBounds(today);
  getDb().prepare('INSERT INTO history (timestamp, daily_solar, daily_consumption, daily_grid_import, daily_grid_export) VALUES (?, ?, ?, ?, ?)')
    .run(start + 3600, 12.34, 20.5, 6.1, 0);
  setConfig('grid_status_entity', 'Grid Status');
  getDb().prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(start - 600, 1);
  getDb().prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(start + 1800, 0);
  getDb().prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(start + 5400, 1);
  const r = await reports.daySummary('today');
  assert.strictEqual(r.title, "Today's energy");
  assert.match(r.body, /☀️ Solar: 12\.3 kWh/);
  assert.match(r.body, /🏠 Used: 20\.5 kWh/);
  assert.match(r.body, /🔌 Grid: 6\.1 kWh in, 0 kWh out/);
  assert.match(r.body, /⚡ Grid available: /);
  // On at start → off at +30 min → on again at +90 min: off for exactly an hour.
  const { end } = reports.dayBounds(today);
  const span = Math.min(end, Math.floor(Date.now() / 1000)) - start;
  assert.strictEqual(reports.gridOnSeconds(getDb(), start, end), span - 3600);
  const y = await reports.daySummary('yesterday');
  assert.match(y.body, /No energy totals recorded/);
});

test('status report uses the role metrics', async () => {
  setConfig('role_metrics', JSON.stringify({ solar: 'PV Power', battery_soc: 'Battery SOC', consumption: 'Load Power' }));
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('PV Power', 2450, now, 'W');
  getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('Load Power', 0.8, now, 'kW');
  const r = await reports.statusReport();
  assert.match(r.body, /☀️ Solar: 2\.45 kW/);
  assert.match(r.body, /🏠 Load: 800 W/);
  assert.match(r.body, /🔋 Battery: 15%/);
  assert.match(r.body, /Updated just now/);
});

test('scheduled forecast report honours "only below"', async () => {
  solar.getSolarForecast = async () => ({ source_label: 'Open-Meteo', daily: [{ date: tomorrow, total_kwh: 3.2, peak_kw: 1.1 }] });
  const rule = { id: 'sf', kind: 'schedule', enabled: true, name: 'Low solar tomorrow', report: 'forecast', day: 'tomorrow', time: '19:00', days: [], below_kwh: 5, severity: 'warning', channels: [TG.id] };
  store.saveRules([rule]);
  sent.length = 0;
  assert.strictEqual((await notifications.runSchedules(at(19, 1))).length, 1);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].msg.title, 'Low solar tomorrow', 'the rule name is the title');
  assert.match(sent[0].msg.body, /^Tomorrow's solar forecast\n☀️ Expected: 3\.2 kWh \(peak 1\.1 kW\)/, 'report title leads the body');
  assert.strictEqual((await notifications.runSchedules(at(19, 2))).length, 0, 'once a day');
  assert.strictEqual(store.getState().schedule.sf, today, 'last run persisted');

  // A sunny day: the rule runs but sends nothing.
  solar.getSolarForecast = async () => ({ daily: [{ date: tomorrow, total_kwh: 18, peak_kw: 4 }] });
  store.saveRules([{ ...rule, id: 'sf2' }]);
  sent.length = 0;
  await notifications.runSchedules(at(19, 3));
  assert.strictEqual(sent.length, 0);
});

test('scheduled reports go out during quiet hours', async () => {
  store.saveSettings({ ...store.getSettings(), quiet_hours: { enabled: true, start: '00:00', end: '23:59' } });
  store.saveRules([{ id: 'sum', kind: 'schedule', enabled: true, name: 'Evening summary', report: 'day_summary', day: 'today', time: '00:00', days: [], severity: 'info', channels: [TG.id] }]);
  sent.length = 0;
  await notifications.runSchedules(at(0, 30));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].msg.title, 'Evening summary');
  assert.match(sent[0].msg.body, /^Today's energy\n/);
  store.saveSettings({ ...store.getSettings(), quiet_hours: { enabled: false, start: '22:00', end: '07:00' } });
  store.saveRules([]);
});

test('schedule rule validation', () => {
  const ok = normalizeRule({ kind: 'schedule', name: 'Summary', report: 'day_summary', day: 'bogus', time: '7:05', days: [0, 1, 2, 3, 4, 5, 6], channels: [TG.id] });
  assert.deepStrictEqual({ day: ok.day, time: ok.time, days: ok.days, severity: ok.severity, below: ok.below_kwh }, { day: 'today', time: '07:05', days: [], severity: 'info', below: 0 });
  assert.throws(() => normalizeRule({ kind: 'schedule', name: 'x', report: 'nope', time: '07:00', channels: [TG.id] }), /report/);
  assert.throws(() => normalizeRule({ kind: 'schedule', name: 'x', report: 'status', time: '25:00', channels: [TG.id] }), /time/);
  assert.strictEqual(normalizeRule({ kind: 'schedule', name: 'x', report: 'forecast', time: '19:00', below_kwh: '4.5', channels: [TG.id] }).below_kwh, 4.5);
});

test('forecast.unavailable is in the catalog for rules to match', () => {
  const { listEventTypes } = require('../modules/notifications/events');
  assert.ok(listEventTypes().some(e => e.type === 'forecast.unavailable'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'solar.js'), 'utf8');
  assert.match(src, /emitEvent\('forecast\.unavailable'/, 'solar.js raises it on Solcast/Open-Meteo failure');
});

test('webhook channel: JSON body, auth header, URL never in errors', async () => {
  const cfg = { webhook_url: 'https://hooks.example.com/api/webhook/SECRET123', auth_header: 'Bearer tok' };
  assert.strictEqual(webhook.validate(cfg), null);
  assert.ok(webhook.validate({ webhook_url: 'ftp://x' }));
  assert.ok(webhook.validate({ webhook_url: 'https://x', auth_header: 'a\r\nInjected: 1' }));
  const { headers, body } = webhook.buildRequest(cfg, { title: 'T', body: 'B', severity: 'critical', event: 'grid.off', timestamp: 1_800_000_000 });
  assert.strictEqual(headers.Authorization, 'Bearer tok');
  assert.deepStrictEqual({ source: body.source, title: body.title, message: body.message, severity: body.severity, event: body.event }, { source: 'epilykos', title: 'T', message: 'B', severity: 'critical', event: 'grid.off' });
  await assert.rejects(webhook.send(cfg, { title: 'T' }, { fetch: async () => { throw new Error('ECONNREFUSED'); } }), (e) => {
    assert.match(e.message, /Could not reach hooks\.example\.com: ECONNREFUSED/);
    assert.ok(!e.message.includes('SECRET123'));
    return true;
  });
});

test('telegram commands: answers only the configured chat', async () => {
  assert.match((await bot.answer('/help')).body, /\/status/);
  assert.match((await bot.answer('/status@MyEnergyBot')).body, /Solar/);
  assert.strictEqual(await bot.answer('hello'), null);
  assert.match((await bot.answer('/nope')).body, /Try \/help/);
  sent.length = 0;
  const cfg = TG.config;
  assert.strictEqual(await bot.handleUpdate(cfg, { message: { chat: { id: 999, type: 'private' }, text: '/status' } }), false, 'stranger ignored');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(await bot.handleUpdate(cfg, { message: { chat: { id: 42, type: 'private' }, text: '/today' } }), true);
  assert.strictEqual(sent[0].msg.title, "Today's energy");
  assert.strictEqual(sent[0].msg.silent, false, 'replies make a sound');
});

test('telegram poller starts only for channels with commands on, and stops', async () => {
  const calls = [];
  bot._setFetch(async (url, init) => {
    calls.push(url.replace(/bot[^/]+/, 'bot<token>'));
    if (url.includes('getUpdates')) {
      await new Promise((r, j) => { const t = setTimeout(r, 5000); init.signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    }
    return { ok: true, json: async () => ({ ok: true, result: [] }) };
  });
  bot.sync();
  assert.strictEqual(bot._pollers.size, 0, 'commands off: no poller');
  store.saveChannels([{ ...TG, config: { ...TG.config, commands: true } }]);
  bot.sync();
  assert.strictEqual(bot._pollers.size, 1);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(calls.some(u => u.endsWith('/setMyCommands')));
  assert.ok(calls.some(u => u.includes('/getUpdates?timeout=50')));
  store.saveChannels([{ ...TG, enabled: false, config: { ...TG.config, commands: true } }]);
  bot.sync();
  assert.strictEqual(bot._pollers.size, 0, 'disabled channel: poller stopped');
});

test('telegram: in a group, commands addressed to another bot are ignored', async () => {
  sent.length = 0;
  const poller = { username: 'EpilykosBot', chats: new Map() };
  const msg = (text) => ({ message: { chat: { id: 42, type: 'group' }, text } });
  assert.strictEqual(await bot.handleUpdate(TG.config, msg('/status@OtherBot'), poller), false);
  assert.strictEqual(await bot.handleUpdate(TG.config, msg('/status@EpilykosBot'), poller), true);
  assert.strictEqual(await bot.handleUpdate(TG.config, { edited_message: { chat: { id: 42 }, text: '/status' } }, poller), false, 'edits are not re-answered');
  assert.strictEqual(sent.length, 1);
});

test('status report shows one signed battery power line', async () => {
  setConfig('role_metrics', JSON.stringify({ battery_charge: 'Battery Power', battery_discharge: 'Battery Power', grid_import: 'Grid Power' }));
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('Battery Power', -650, now, 'W');
  getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('Grid Power', 0, now, 'W');
  const r = await reports.statusReport();
  assert.match(r.body, /🔋 Battery power: -650 W/);
  assert.ok(!/Charging|Discharging/.test(r.body));
  assert.ok(!/Grid import/.test(r.body), 'zero flows are left out');
});

test('source events use friendly names', () => {
  const { onEvent } = require('../modules/notifications/events');
  let msg = '';
  const off = onEvent(e => { if (e.type === 'source.offline') msg = e.message; });
  for (let i = 0; i < 3; i++) notifications.noteSourceResult('ha', false, new Error('timeout'));
  off();
  assert.match(msg, /^Home Assistant failed 3 polls in a row: timeout/);
});
