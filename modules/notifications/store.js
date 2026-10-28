'use strict';
/**
 * modules/notifications/store.js — persistence for notifications.
 *
 * Channels, rules, devices, settings and the VAPID key pair are JSON config
 * keys, so they ride along in backups and their secret leaves are encrypted
 * at rest via SECRET_FIELDS (modules/encryption.js). The delivery log is the
 * notification_log table, capped at LOG_CAP rows.
 *
 * Secrets never go back to the browser: publicChannel() blanks them and adds
 * has_<field>: true; mergeChannelConfig() keeps a stored secret when the
 * form sends it back empty.
 */

const crypto = require('crypto');
const { getConfig, setConfig, getDb } = require('../database');
const { logger } = require('../logger');

const KEYS = {
  settings: 'notification_settings',
  channels: 'notification_channels',
  rules: 'notification_rules',
  devices: 'notification_devices',
  vapid: 'notification_vapid',
  state: 'notification_state',
};
const LOG_CAP = 500;

const DEFAULT_SETTINGS = {
  enabled: true,
  quiet_hours: { enabled: false, start: '22:00', end: '07:00' },
  base_url: '',
};

function readJson(key, fallback) {
  const raw = getConfig(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) {
    logger.warn(`notifications: ${key} is not valid JSON (${e.message}); using defaults`);
    return fallback;
  }
}
function writeJson(key, value) { setConfig(key, JSON.stringify(value)); }

function newId(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

function getSettings() {
  const s = readJson(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...s, quiet_hours: { ...DEFAULT_SETTINGS.quiet_hours, ...(s.quiet_hours || {}) } };
}
function saveSettings(s) { writeJson(KEYS.settings, s); }

function getChannels() { const v = readJson(KEYS.channels, []); return Array.isArray(v) ? v : []; }
function saveChannels(list) { writeJson(KEYS.channels, list); }
function getRules() { const v = readJson(KEYS.rules, []); return Array.isArray(v) ? v : []; }
function saveRules(list) { writeJson(KEYS.rules, list); }
/** Rule state kept across restarts: { metric, events, schedule } (see index.js). */
function getState() { const v = readJson(KEYS.state, {}); return v && typeof v === 'object' ? v : {}; }
function saveState(v) { writeJson(KEYS.state, v); }

function getDevices() { const v = readJson(KEYS.devices, []); return Array.isArray(v) ? v : []; }
function saveDevices(list) { writeJson(KEYS.devices, list); }

/** Remove a push device and drop it from push channels that list it. */
function removeDevice(id) {
  saveDevices(getDevices().filter(d => d.id !== id));
  saveChannels(getChannels().map(c => (c.type === 'webpush' && c.config && Array.isArray(c.config.devices))
    ? { ...c, config: { ...c.config, devices: c.config.devices.filter(x => x !== id) } } : c));
}

/** Channel as the browser sees it: secrets replaced by has_<field> flags. */
function publicChannel(ch, secretFields) {
  const config = { ...(ch.config || {}) };
  for (const f of secretFields || []) {
    config['has_' + f] = !!config[f];
    config[f] = '';
  }
  return { ...ch, config };
}

/** Incoming config over the stored one: empty secret fields keep the stored value. */
function mergeChannelConfig(stored, incoming, secretFields) {
  const out = { ...incoming };
  for (const k of Object.keys(out)) if (k.startsWith('has_')) delete out[k];
  for (const f of secretFields || []) {
    if ((out[f] === undefined || out[f] === '') && stored && stored[f]) out[f] = stored[f];
  }
  return out;
}

/** Device as the browser sees it (no keys; endpoint host and hash only). */
function publicDevice(d) {
  let host = '';
  try { host = new URL(d.endpoint).host; } catch (_) { /* malformed */ }
  // endpoint_hash lets a browser recognise its own subscription without the
  // endpoint (a capability URL) ever being sent back.
  const endpoint_hash = crypto.createHash('sha256').update(String(d.endpoint || '')).digest('hex');
  return { id: d.id, label: d.label, user_agent: d.user_agent, service: host, endpoint_hash, created_at: d.created_at, last_ok_at: d.last_ok_at || null, last_error_at: d.last_error_at || null };
}

/** VAPID keys, generated on first use and stored encrypted. */
function getVapid() {
  const v = readJson(KEYS.vapid, null);
  if (v && v.publicKey && v.privateKey) return { subject: 'https://github.com/ashipaek0/epilykos', ...v };
  if (v && v.publicKey) logger.warn('notifications: the saved web push key could not be read, so a new pair is made. Devices subscribed with the old key must subscribe again.');
  const keys = require('web-push').generateVAPIDKeys();
  const created = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'https://github.com/ashipaek0/epilykos' };
  writeJson(KEYS.vapid, created);
  logger.info('notifications: generated VAPID keys for web push');
  return created;
}

// ── Delivery log ─────────────────────────────────────────────────────

function ensureSchema(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp    INTEGER NOT NULL,
      rule_id      TEXT,
      rule_name    TEXT,
      channel_id   TEXT,
      channel_name TEXT,
      severity     TEXT,
      title        TEXT,
      body         TEXT,
      status       TEXT NOT NULL,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notification_log_ts ON notification_log(timestamp);
  `);
}

/** Run fn(db); create the log table and retry once if it is missing (e.g. after restoring an older backup). */
function withLog(fn) {
  const db = getDb();
  try { return fn(db); } catch (e) {
    if (!/no such table: notification_log/.test(e.message)) throw e;
    ensureSchema(db);
    return fn(db);
  }
}

function addLog(entry) {
  try {
    withLog((db) => {
      db.prepare(`INSERT INTO notification_log (timestamp, rule_id, rule_name, channel_id, channel_name, severity, title, body, status, error)
        VALUES (@timestamp, @rule_id, @rule_name, @channel_id, @channel_name, @severity, @title, @body, @status, @error)`).run({
        timestamp: Math.floor(Date.now() / 1000), rule_id: null, rule_name: null, channel_id: null, channel_name: null,
        severity: null, title: null, body: null, error: null, ...entry,
      });
      db.prepare('DELETE FROM notification_log WHERE id <= (SELECT MAX(id) FROM notification_log) - ?').run(LOG_CAP);
    });
  } catch (e) {
    logger.warn(`notifications: could not write log: ${e.message}`);
  }
}

function getLog(limit = 100) {
  return withLog(db => db.prepare('SELECT * FROM notification_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, limit | 0), LOG_CAP)));
}
function clearLog() { withLog(db => db.prepare('DELETE FROM notification_log').run()); }

module.exports = {
  KEYS,
  DEFAULT_SETTINGS,
  newId,
  getSettings, saveSettings,
  getChannels, saveChannels,
  getRules, saveRules,
  getDevices, saveDevices, removeDevice,
  getState, saveState,
  publicChannel, mergeChannelConfig, publicDevice,
  getVapid,
  ensureSchema, addLog, getLog, clearLog,
};
