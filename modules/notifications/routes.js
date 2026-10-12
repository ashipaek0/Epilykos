'use strict';
/**
 * /api/notifications — admin-only API for the Notifications settings section.
 * Mounted behind isAuthenticated (and the /api CSRF guard) in server.js.
 */

const express = require('express');
const { logger } = require('../logger');
const { assertSafeFetchUrl } = require('../utils');
const store = require('./store');
const { listEventTypes, SEVERITIES } = require('./events');
const { OPERATORS } = require('./rules');
const { CHANNEL_TYPES, deliver, sendToChannel } = require('./dispatcher');
const { REPORTS } = require('./reports');
const { clockMinutes } = require('./rules');
const telegramBot = require('./telegramBot');

const CHANNEL_FIELDS = {
  telegram: ['bot_token', 'chat_id', 'commands'],
  discord: ['webhook_url', 'mention_here'],
  ntfy: ['server_url', 'topic', 'token', 'allow_private'],
  webpush: ['devices'],
  webhook: ['webhook_url', 'auth_header', 'allow_private'],
};
const BOOL_FIELDS = new Set(['mention_here', 'allow_private', 'commands']);
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'stale']);

class InputError extends Error {}
const fail = (msg) => { throw new InputError(msg); };

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function int(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Validate a channel from the browser over its stored version (if any). */
function normalizeChannel(input, stored) {
  const type = stored ? stored.type : str(input.type, 20);
  const mod = CHANNEL_TYPES[type];
  if (!mod) fail('Unknown channel type');
  const name = str(input.name, 60) || mod.label;
  const raw = {};
  for (const f of CHANNEL_FIELDS[type]) {
    const v = (input.config || {})[f];
    if (BOOL_FIELDS.has(f)) raw[f] = !!v;
    else if (f === 'devices') raw[f] = v === 'all' ? 'all' : (Array.isArray(v) ? v.map(x => str(x, 40)).filter(Boolean) : []);
    else raw[f] = str(v, 500);
  }
  const config = store.mergeChannelConfig(stored && stored.config, raw, mod.secretFields);
  if (type === 'webpush' && Array.isArray(config.devices)) {
    const known = new Set(store.getDevices().map(d => d.id));
    config.devices = config.devices.filter(id => known.has(id));
  }
  const err = mod.validate(config);
  if (err) fail(err);
  return { id: stored ? stored.id : store.newId('ch'), type, name, enabled: input.enabled !== false, config };
}

function normalizeRule(input, stored) {
  const kind = ['event', 'schedule'].includes(input.kind) ? input.kind : 'metric';
  const name = str(input.name, 80);
  if (!name) fail('Give the rule a name');
  const knownChannels = new Set(store.getChannels().map(c => c.id));
  const channels = (Array.isArray(input.channels) ? input.channels : []).map(x => str(x, 40)).filter(id => knownChannels.has(id));
  if (!channels.length) fail('Pick at least one channel to send to');
  const severity = SEVERITIES.includes(input.severity) ? input.severity : ({ event: '', schedule: 'info' }[kind] ?? 'warning');
  const rule = {
    id: stored ? stored.id : store.newId('rule'),
    kind, name, enabled: input.enabled !== false, channels, severity,
    cooldown_s: int(input.cooldown_s, 0, 7 * 86400, kind === 'event' ? 0 : 900),
    message: str(input.message, 500),
  };
  if (kind === 'metric') {
    rule.metric = str(input.metric, 200);
    if (!rule.metric) fail('Pick a metric');
    rule.operator = OPERATORS[input.operator] ? input.operator : fail('Pick a condition');
    if (rule.operator === 'changes') rule.value = '';
    else if (NUMERIC_OPS.has(rule.operator)) {
      const n = Number(input.value);
      if (input.value === '' || input.value == null || !Number.isFinite(n)) fail('The value must be a number');
      if (rule.operator === 'stale' && n <= 0) fail('Minutes must be more than 0');
      rule.value = n;
    } else {
      rule.value = str(input.value, 200);
      if (rule.value === '') fail('Enter the value to compare with');
    }
    rule.for_s = int(input.for_s, 0, 86400, 0);
    rule.hysteresis = Math.max(0, Number(input.hysteresis) || 0);
    rule.repeat_s = int(input.repeat_s, 0, 7 * 86400, 0);
    if (rule.repeat_s && rule.repeat_s < 300) rule.repeat_s = 300;
    rule.notify_resolved = !!input.notify_resolved;
  } else if (kind === 'schedule') {
    const def = REPORTS[input.report] || fail('Pick a report');
    rule.report = input.report;
    rule.day = def.days.length ? (def.days.includes(input.day) ? input.day : def.days[0]) : '';
    rule.time = clockMinutes(input.time) !== null ? String(input.time).trim().padStart(5, '0') : fail('Pick a time (HH:MM)');
    rule.days = (Array.isArray(input.days) ? input.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
    if (rule.days.length === 7) rule.days = [];
    rule.below_kwh = rule.report === 'forecast' ? Math.max(0, Number(input.below_kwh) || 0) : 0;
    rule.cooldown_s = 0;
  } else {
    rule.event = str(input.event, 80);
    if (!/^(\*|[\w-]+(\.[\w-]+)*(\.\*)?)$/.test(rule.event)) fail('Pick an event');
    rule.subject = str(input.subject, 120);
  }
  return rule;
}

function publicChannels() {
  return store.getChannels().map(c => store.publicChannel(c, (CHANNEL_TYPES[c.type] || {}).secretFields));
}

function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? (/iPad/.test(s) ? 'iPad' : 'iPhone') : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'Device';
  const br = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof InputError) return res.status(400).json({ error: e.message });
      logger.error('notifications API error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

function createRouter() {
  const r = express.Router();

  r.get('/state', handle((req, res) => {
    res.json({
      settings: store.getSettings(),
      channels: publicChannels(),
      rules: store.getRules(),
      devices: store.getDevices().map(store.publicDevice),
      eventTypes: listEventTypes(),
      operators: Object.entries(OPERATORS).map(([id, o]) => ({ id, label: o.label })),
      reports: Object.entries(REPORTS).map(([id, r]) => ({ id, label: r.label, days: r.days })),
      channelTypes: Object.values(CHANNEL_TYPES).map(m => ({ type: m.type, label: m.label })),
      vapidPublicKey: store.getVapid().publicKey,
    });
  }));

  r.put('/settings', handle((req, res) => {
    const b = req.body || {};
    const cur = store.getSettings();
    const clock = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? String(v) : d);
    const q = b.quiet_hours || {};
    const next = {
      ...cur,
      enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled,
      quiet_hours: { enabled: !!q.enabled, start: clock(q.start, cur.quiet_hours.start), end: clock(q.end, cur.quiet_hours.end) },
      base_url: str(b.base_url, 300),
    };
    if (next.base_url && !/^https?:\/\//i.test(next.base_url)) fail('Dashboard address must start with https:// or http://');
    store.saveSettings(next);
    res.json(next);
  }));

  // ── Channels ──
  r.post('/channels', handle((req, res) => {
    const ch = normalizeChannel(req.body || {}, null);
    store.saveChannels([...store.getChannels(), ch]);
    telegramBot.sync();
    res.json(store.publicChannel(ch, CHANNEL_TYPES[ch.type].secretFields));
  }));

  r.put('/channels/:id', handle((req, res) => {
    const list = store.getChannels();
    const i = list.findIndex(c => c.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Channel not found' });
    list[i] = normalizeChannel(req.body || {}, list[i]);
    store.saveChannels(list);
    telegramBot.sync();
    res.json(store.publicChannel(list[i], CHANNEL_TYPES[list[i].type].secretFields));
  }));

  r.delete('/channels/:id', handle((req, res) => {
    const id = req.params.id;
    store.saveChannels(store.getChannels().filter(c => c.id !== id));
    // Rules keep working with the channels they have left.
    store.saveRules(store.getRules().map(rule => ({ ...rule, channels: (rule.channels || []).filter(c => c !== id) })));
    telegramBot.sync();
    res.json({ success: true });
  }));

  // Test a channel as it is in the form (unsaved edits included).
  r.post('/channels/test', handle(async (req, res) => {
    const b = req.body || {};
    const stored = b.id ? store.getChannels().find(c => c.id === b.id) : null;
    const ch = normalizeChannel(b, stored);
    const msg = { title: 'Epilykos test notification', body: `"${ch.name}" is set up. Alerts will arrive like this.`, severity: 'warning', tag: 'test', timestamp: Math.floor(Date.now() / 1000) };
    const settings = store.getSettings();
    if (settings.base_url) msg.url = settings.base_url.replace(/\/+$/, '') + '/';
    const result = await sendToChannel(ch, msg, { retry: false });
    store.addLog({ rule_name: 'Test', channel_id: stored ? stored.id : null, channel_name: ch.name, severity: 'warning', title: msg.title, body: msg.body, status: result.ok ? 'sent' : 'failed', error: result.error });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ success: true, warning: result.error || null });
  }));

  r.post('/telegram/chats', handle(async (req, res) => {
    const b = req.body || {};
    let token = str(b.bot_token, 200);
    if (!token && b.id) {
      const stored = store.getChannels().find(c => c.id === b.id);
      token = stored && stored.config && stored.config.bot_token;
    }
    if (!token) fail('Enter the bot token first');
    // While this bot answers commands its poller owns getUpdates; use what it has seen.
    const seen = telegramBot.knownChats(token);
    if (seen) return res.json({ chats: seen });
    try {
      res.json({ chats: await CHANNEL_TYPES.telegram.findChats(token) });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }));

  // ── Rules ──
  r.post('/rules', handle((req, res) => {
    const rule = normalizeRule(req.body || {}, null);
    store.saveRules([...store.getRules(), rule]);
    res.json(rule);
  }));

  r.put('/rules/:id', handle((req, res) => {
    const list = store.getRules();
    const i = list.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Rule not found' });
    list[i] = normalizeRule(req.body || {}, list[i]);
    store.saveRules(list);
    res.json(list[i]);
  }));

  r.delete('/rules/:id', handle((req, res) => {
    store.saveRules(store.getRules().filter(x => x.id !== req.params.id));
    res.json({ success: true });
  }));

  r.post('/rules/:id/test', handle(async (req, res) => {
    const rule = store.getRules().find(x => x.id === req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    if (rule.kind === 'schedule') {
      // Send the real report now, ignoring any "only below" condition.
      const rep = await require('./index').buildReport(rule);
      const out = await deliver({ title: rep.title, body: rep.body, severity: rule.severity || 'info', tag: 'test-' + rule.id }, rule.channels, rule, { force: true, retry: false });
      return res.json({ results: out, skipped: rep.skip || null });
    }
    const results = await deliver({ title: `Test: ${rule.name}`, body: 'This is how this rule\'s alerts will arrive.', severity: rule.severity || 'warning', tag: 'test-' + rule.id }, rule.channels, rule, { force: true, retry: false });
    res.json({ results });
  }));

  // ── Push devices ──
  r.post('/devices', handle(async (req, res) => {
    const sub = (req.body || {}).subscription || {};
    const endpoint = str(sub.endpoint, 1000);
    const keys = sub.keys || {};
    if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) fail('The browser did not return a usable push subscription');
    // The endpoint is where the server will POST: keep it to public hosts.
    const safe = await assertSafeFetchUrl(endpoint);
    if (!safe.ok) fail('Push service address not allowed');
    const list = store.getDevices();
    const ua = str(req.get('user-agent'), 300);
    const label = str((req.body || {}).label, 60) || deviceLabel(ua);
    let dev = list.find(d => d.endpoint === endpoint);
    if (dev) Object.assign(dev, { keys: { p256dh: str(keys.p256dh, 200), auth: str(keys.auth, 200) }, label, user_agent: ua });
    else {
      dev = { id: store.newId('dev'), label, endpoint, keys: { p256dh: str(keys.p256dh, 200), auth: str(keys.auth, 200) }, user_agent: ua, created_at: Math.floor(Date.now() / 1000) };
      list.push(dev);
    }
    store.saveDevices(list);
    // First device: give the user a working push channel straight away.
    let channel = null;
    if (!store.getChannels().some(c => c.type === 'webpush')) {
      channel = { id: store.newId('ch'), type: 'webpush', name: 'All my devices', enabled: true, config: { devices: 'all' } };
      store.saveChannels([...store.getChannels(), channel]);
    }
    res.json({ device: store.publicDevice(dev), channel });
  }));

  r.patch('/devices/:id', handle((req, res) => {
    const list = store.getDevices();
    const dev = list.find(d => d.id === req.params.id);
    if (!dev) return res.status(404).json({ error: 'Device not found' });
    const label = str((req.body || {}).label, 60);
    if (!label) fail('Give the device a name');
    dev.label = label;
    store.saveDevices(list);
    res.json(store.publicDevice(dev));
  }));

  r.delete('/devices/:id', handle((req, res) => {
    const id = req.params.id;
    store.saveDevices(store.getDevices().filter(d => d.id !== id));
    store.saveChannels(store.getChannels().map(c => (c.type === 'webpush' && Array.isArray(c.config.devices))
      ? { ...c, config: { ...c.config, devices: c.config.devices.filter(x => x !== id) } } : c));
    res.json({ success: true });
  }));

  r.post('/devices/:id/test', handle(async (req, res) => {
    const dev = store.getDevices().find(d => d.id === req.params.id);
    if (!dev) return res.status(404).json({ error: 'Device not found' });
    const ch = { id: 'device-test', type: 'webpush', name: dev.label, enabled: true, config: { devices: [dev.id] } };
    const result = await sendToChannel(ch, { title: 'Epilykos test notification', body: `Push works on ${dev.label}.`, severity: 'warning', tag: 'test', url: '/' }, { retry: false });
    store.addLog({ rule_name: 'Test', channel_name: `Push · ${dev.label}`, severity: 'warning', title: 'Epilykos test notification', status: result.ok ? 'sent' : 'failed', error: result.error });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ success: true });
  }));

  // ── Log ──
  r.get('/log', handle((req, res) => res.json(store.getLog(Number(req.query.limit) || 100))));
  r.delete('/log', handle((req, res) => { store.clearLog(); res.json({ success: true }); }));

  return r;
}

module.exports = { createRouter, normalizeRule, normalizeChannel, deviceLabel };
