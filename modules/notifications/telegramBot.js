'use strict';
/**
 * modules/notifications/telegramBot.js — answer commands in Telegram.
 *
 * For each enabled Telegram channel with "Answer commands" on, long-polls
 * getUpdates (no public URL needed, unlike a webhook) and replies to
 * /status, /today, /yesterday, /forecast and /help. Only messages from the
 * channel's own chat get an answer; anything else is ignored, so a stranger
 * who finds the bot learns nothing.
 *
 * sync() is called at start-up and whenever channels change; it starts the
 * pollers that should run and stops the rest.
 */

const crypto = require('crypto');
const { logger } = require('../logger');
const { safeFetch } = require('../utils');
const store = require('./store');
const reports = require('./reports');
const telegram = require('./channels/telegram');

const API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 50;
const BACKOFF_MS = [5000, 15000, 60000];

const COMMANDS = [
  { command: 'status', description: 'Live power, battery and grid' },
  { command: 'today', description: "Today's energy so far" },
  { command: 'yesterday', description: "Yesterday's energy" },
  { command: 'forecast', description: "Tomorrow's solar forecast" },
  { command: 'help', description: 'What I can do' },
];

let fetchImpl = (url, init) => safeFetch(url, init);
const pollers = new Map(); // channel id → poller

function tokenKey(token) { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16); }

const sleep = (ms, poller) => new Promise(r => {
  const t = setTimeout(r, ms);
  if (t.unref) t.unref();
  poller.wake = () => { clearTimeout(t); r(); };
});

/** Reply text for a command, or null for messages that are not ours. */
async function answer(text) {
  const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  switch (cmd) {
    case '/status': return reports.statusReport();
    case '/today': return reports.daySummary('today');
    case '/yesterday': return reports.daySummary('yesterday');
    case '/forecast': return reports.forecastReport(/today/i.test(text) ? 'today' : 'tomorrow');
    case '/start':
    case '/help':
      return { title: 'Epilykos', body: COMMANDS.map(c => `/${c.command} — ${c.description}`).join('\n') };
    default:
      return cmd.startsWith('/') ? { title: 'Epilykos', body: `I don't know ${cmd}. Try /help.` } : null;
  }
}

/** Handle one getUpdates result for `config`. Exported for tests. */
async function handleUpdate(config, update, poller) {
  const m = update.message;
  if (!m || !m.chat) return false;
  if (poller) poller.chats.set(String(m.chat.id), { id: String(m.chat.id), type: m.chat.type, name: m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || String(m.chat.id) });
  if (String(m.chat.id) !== String(config.chat_id).trim()) return false;
  // In a group, "/status@OtherBot" is for another bot.
  const addressed = /^\/\w+@(\w+)/.exec(String(m.text || '').trim());
  if (addressed && poller && poller.username && addressed[1].toLowerCase() !== poller.username.toLowerCase()) return false;
  const reply = await answer(m.text);
  if (!reply) return false;
  await telegram.send(config, { title: reply.title, body: reply.body, severity: 'info', icon: false, silent: false }, { fetch: fetchImpl });
  return true;
}

async function loop(poller) {
  let offset = 0, failures = 0;
  const base = `${API}/bot${String(poller.config.bot_token).trim()}`;
  try {
    const me = await (await fetchImpl(`${base}/getMe`, { signal: AbortSignal.timeout(15000) })).json();
    if (me && me.ok && me.result) poller.username = me.result.username || '';
  } catch (_) { /* replies still work without it */ }
  try {
    await fetchImpl(`${base}/setMyCommands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: COMMANDS }), signal: AbortSignal.timeout(15000) });
  } catch (_) { /* the menu is a nicety */ }
  while (poller.running) {
    try {
      const url = `${base}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
      const ctrl = new AbortController();
      poller.abort = () => ctrl.abort();
      const timer = setTimeout(() => ctrl.abort(), (POLL_TIMEOUT_S + 15) * 1000);
      let res;
      try {
        res = await fetchImpl(url, { signal: ctrl.signal });
      } catch (e) {
        if (!poller.running) break;
        throw new Error(`Could not reach api.telegram.org: ${e.message}`);
      } finally { clearTimeout(timer); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const err = new Error(`Telegram ${res.status}${data.description ? ': ' + data.description : ''}`);
        err.status = res.status;
        throw err;
      }
      failures = 0;
      for (const u of data.result || []) {
        offset = Math.max(offset, u.update_id + 1);
        try { await handleUpdate(poller.config, u, poller); } catch (e) { logger.warn(`notifications: Telegram reply failed: ${e.message}`); }
      }
    } catch (e) {
      if (!poller.running) break;
      const wait = e.status === 409 || e.status === 401 ? 60000 : BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      if (failures === 0 || e.status === 409) logger.warn(`notifications: Telegram commands for "${poller.name}": ${e.message}${e.status === 409 ? ' (another program is reading this bot\'s updates)' : ''}`);
      failures++;
      await sleep(wait, poller);
    }
  }
}

function start(channel) {
  const poller = { id: channel.id, name: channel.name, key: tokenKey(channel.config.bot_token) + '|' + channel.config.chat_id, config: { ...channel.config }, running: true, username: '', chats: new Map(), abort: null, wake: null };
  pollers.set(channel.id, poller);
  loop(poller).catch(e => logger.warn(`notifications: Telegram poller stopped: ${e.message}`));
  logger.info(`notifications: answering Telegram commands for "${channel.name}"`);
}

function stop(id) {
  const p = pollers.get(id);
  if (!p) return;
  p.running = false;
  if (p.abort) p.abort();
  if (p.wake) p.wake();
  pollers.delete(id);
}

/** Start/stop pollers to match the saved channels. */
function sync() {
  let want = [];
  try {
    want = store.getChannels().filter(c => c.type === 'telegram' && c.enabled && c.config && c.config.commands && !telegram.validate(c.config));
  } catch (e) {
    logger.warn(`notifications: could not read Telegram channels: ${e.message}`);
  }
  // One poller per bot token: Telegram allows a single getUpdates reader.
  const seenTokens = new Set();
  const wanted = new Map();
  for (const c of want) {
    const k = tokenKey(c.config.bot_token);
    if (seenTokens.has(k)) continue;
    seenTokens.add(k);
    wanted.set(c.id, c);
  }
  for (const [id, p] of pollers) {
    const c = wanted.get(id);
    if (!c || p.key !== tokenKey(c.config.bot_token) + '|' + c.config.chat_id) stop(id);
  }
  for (const [id, c] of wanted) if (!pollers.has(id)) start(c);
}

function stopAll() { for (const id of [...pollers.keys()]) stop(id); }

/** Chats a running poller has seen for this token (getUpdates can't be called while it polls). */
function knownChats(botToken) {
  const k = tokenKey(botToken);
  for (const p of pollers.values()) if (tokenKey(p.config.bot_token) === k) return [...p.chats.values()];
  return null;
}

module.exports = { sync, stopAll, knownChats, answer, handleUpdate, COMMANDS, _setFetch(f) { fetchImpl = f; }, _pollers: pollers };
