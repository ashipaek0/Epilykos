'use strict';
/**
 * modules/notifications/dispatcher.js — deliver one message to a rule's channels.
 *
 * Quiet hours hold back everything below 'critical'. Each channel send is
 * retried (RETRY_DELAYS_MS) so a brief Telegram or network blip does not
 * drop a grid-outage alert; every final outcome lands in notification_log.
 * Deliveries never throw into the caller (the poll cycle / event emitter).
 */

const { logger } = require('../logger');
const store = require('./store');

const CHANNEL_TYPES = {
  telegram: require('./channels/telegram'),
  discord: require('./channels/discord'),
  ntfy: require('./channels/ntfy'),
  webpush: require('./channels/webpush'),
};

const RETRY_DELAYS_MS = [5000, 30000];

/** "HH:MM" → minutes after midnight, or null. */
function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

/** Inside the quiet window (local time; a start after the end wraps midnight)? */
function isQuietNow(settings, date = new Date()) {
  const q = settings && settings.quiet_hours;
  if (!q || !q.enabled) return false;
  const start = parseClock(q.start), end = parseClock(q.end);
  if (start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? (now >= start && now < end) : (now >= start || now < end);
}

function channelDeps(channel) {
  if (channel.type !== 'webpush') return {};
  return {
    vapid: store.getVapid(),
    getDevices: store.getDevices,
    removeDevice(id) {
      store.saveDevices(store.getDevices().filter(d => d.id !== id));
      logger.info(`notifications: removed expired push device ${id}`);
    },
    markDevice(id, ok) {
      const list = store.getDevices();
      const d = list.find(x => x.id === id);
      if (!d) return;
      d[ok ? 'last_ok_at' : 'last_error_at'] = Math.floor(Date.now() / 1000);
      store.saveDevices(list);
    },
  };
}

const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/** Send to one channel with retries. Resolves { ok, error }. */
async function sendToChannel(channel, message, opts = {}) {
  const mod = CHANNEL_TYPES[channel.type];
  if (!mod) return { ok: false, error: `Unknown channel type ${channel.type}` };
  const delays = opts.retry === false ? [] : RETRY_DELAYS_MS;
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await mod.send(channel.config || {}, message, channelDeps(channel));
      const partial = result && result.failures && result.failures.length ? result.failures.join('; ') : null;
      return { ok: true, error: partial };
    } catch (e) {
      lastErr = e;
      // Configuration errors will not fix themselves; don't retry them.
      if (mod.validate && mod.validate(channel.config || {})) break;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  return { ok: false, error: (lastErr && lastErr.message) || String(lastErr) };
}

/**
 * Deliver `message` ({ title, body, severity, tag, url? }) to `channelIds`.
 * `rule` is for the log. opts.force skips the enabled/quiet checks (tests).
 */
async function deliver(message, channelIds, rule, opts = {}) {
  const settings = store.getSettings();
  const msg = { timestamp: Math.floor(Date.now() / 1000), ...message };
  if (!msg.url && settings.base_url) msg.url = String(settings.base_url).replace(/\/+$/, '') + '/';
  const base = { rule_id: rule ? rule.id : null, rule_name: rule ? rule.name : (opts.label || null), severity: msg.severity, title: msg.title, body: msg.body };

  if (!opts.force) {
    if (!settings.enabled) return [];
    if (msg.severity !== 'critical' && isQuietNow(settings)) {
      store.addLog({ ...base, status: 'quiet', error: 'Held back by quiet hours' });
      return [];
    }
  }

  const channels = store.getChannels();
  const results = await Promise.all((channelIds || []).map(async (id) => {
    const ch = channels.find(c => c.id === id);
    if (!ch) return { id, ok: false, error: 'Channel no longer exists' };
    if (!ch.enabled && !opts.force) return { id, ok: false, skipped: true };
    const r = await sendToChannel(ch, msg, opts);
    store.addLog({ ...base, channel_id: ch.id, channel_name: ch.name, status: r.ok ? 'sent' : 'failed', error: r.error });
    if (!r.ok) logger.warn(`notifications: ${ch.type} "${ch.name}" failed: ${r.error}`);
    return { id, name: ch.name, ...r };
  }));
  return results;
}

module.exports = { CHANNEL_TYPES, deliver, sendToChannel, isQuietNow, parseClock };
