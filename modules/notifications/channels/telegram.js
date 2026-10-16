'use strict';
/**
 * Telegram channel — Bot API sendMessage.
 * config: { bot_token, chat_id, commands }. Info-level messages are sent
 * silently (disable_notification), so only warnings and critical alerts make
 * a sound. commands: answer /status etc. in this chat (telegramBot.js).
 */

const { safeFetch } = require('../../utils');
const { postJson, request } = require('./http');

const API = 'https://api.telegram.org';
// Update kinds Find chat and the command bot ask for. Telegram remembers the
// last list a bot asked for, so every getUpdates call must send it in full.
const ALLOWED_UPDATES = ['message', 'channel_post', 'my_chat_member'];
const CHAT_NOT_FOUND = 'Telegram: chat not found. For a channel or group, add the bot as an admin that can post messages. For a private chat, open the bot and press Start. Then use Find chat.';
const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function validate(config) {
  if (!config.bot_token || !/^\d+:[\w-]{20,}$/.test(String(config.bot_token).trim())) return 'Bot token looks wrong (it reads like 123456:ABC…)';
  if (!config.chat_id || !/^(-?\d+|@[\w]{4,})$/.test(String(config.chat_id).trim())) return 'Chat ID must be a number (or @channelname)';
  // The number before the colon in the token is the bot itself; a bot can't message itself.
  if (String(config.chat_id).trim() === String(config.bot_token).trim().split(':')[0]) return "That Chat ID is the bot's own ID (the start of the token). Message your bot, then use Find chat to pick your chat.";
  return null;
}

function buildRequest(config, msg) {
  const icon = msg.icon === false ? '' : (ICON[msg.severity] || '');
  const text = `${icon} <b>${escapeHtml(msg.title)}</b>\n${escapeHtml(msg.body)}`.trim();
  const body = {
    chat_id: String(config.chat_id).trim(),
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_notification: msg.silent !== undefined ? !!msg.silent : msg.severity === 'info',
    link_preview_options: { is_disabled: true },
  };
  return { url: `${API}/bot${String(config.bot_token).trim()}/sendMessage`, body };
}

async function send(config, msg, deps = {}) {
  const err = validate(config);
  if (err) throw new Error(err);
  const { url, body } = buildRequest(config, msg);
  const post = (b) => postJson(deps.fetch || safeFetch, url, b, { label: 'Telegram', detailKey: 'description' });
  try {
    try {
      await post(body);
    } catch (e) {
      // A channel ID copied from the app (no "-100") — try the API form once.
      if (!/chat not found/i.test(e.message) || !/^\d+$/.test(body.chat_id)) throw e;
      await post({ ...body, chat_id: '-100' + body.chat_id });
    }
  } catch (e) {
    // Telegram's own wording doesn't say what to do about it.
    if (/chat not found/i.test(e.message)) e.message = CHAT_NOT_FOUND;
    else if (/bot was blocked/i.test(e.message)) e.message = 'Telegram: the bot is blocked in this chat. Unblock it in Telegram.';
    throw e;
  }
}

/**
 * Chats that have messaged the bot recently (getUpdates), so the settings
 * page can offer a chat ID instead of asking the user to dig for it.
 */
async function findChats(botToken, deps = {}) {
  const err = validate({ bot_token: botToken, chat_id: '0' });
  if (err) throw new Error(err);
  const fetchImpl = deps.fetch || safeFetch;
  const res = await request(fetchImpl, `${API}/bot${String(botToken).trim()}/getUpdates?allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))}`, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram ${res.status}${data.description ? ': ' + data.description : ''}`);
  const chats = new Map();
  for (const u of data.result || []) {
    const m = u.message || u.channel_post || u.my_chat_member || u.edited_message;
    const c = m && m.chat;
    if (c && !chats.has(c.id)) chats.set(c.id, { id: String(c.id), type: c.type, name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id) });
  }
  return [...chats.values()];
}

/**
 * The chat ID as the Bot API knows it. Telegram apps show channel and
 * supergroup IDs without the "-100" prefix the API needs (1234567890 is
 * -1001234567890), so a plain positive ID is tried both ways with getChat.
 * Resolves { chat_id, title, type, changed }. A chat Telegram doesn't know
 * throws the friendly chat-not-found error; network errors pass through.
 */
async function resolveChat(config, deps = {}) {
  const fetchImpl = deps.fetch || safeFetch;
  const token = String(config.bot_token).trim();
  const id = String(config.chat_id).trim();
  const candidates = /^\d+$/.test(id) ? [id, '-100' + id] : [id];
  for (const chatId of candidates) {
    try {
      const res = await postJson(fetchImpl, `${API}/bot${token}/getChat`, { chat_id: chatId }, { label: 'Telegram', detailKey: 'description' });
      const chat = ((await res.json().catch(() => ({}))) || {}).result || {};
      const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chatId;
      return { chat_id: chatId, title, type: chat.type || '', changed: chatId !== id };
    } catch (e) {
      if (e.status !== 400) throw e; // network trouble or a bad token: not about this ID
    }
  }
  throw Object.assign(new Error(CHAT_NOT_FOUND), { status: 400, permanent: true });
}

module.exports = { type: 'telegram', label: 'Telegram', secretFields: ['bot_token'], ALLOWED_UPDATES, validate, buildRequest, send, findChats, resolveChat };
