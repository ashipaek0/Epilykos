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
  try {
    await postJson(deps.fetch || safeFetch, url, body, { label: 'Telegram', detailKey: 'description' });
  } catch (e) {
    // Telegram's own wording doesn't say what to do about it.
    if (/chat not found/i.test(e.message)) e.message = 'Telegram: chat not found. Open your bot in Telegram, press Start or send it a message, then use Find chat to pick the chat.';
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
  const res = await request(fetchImpl, `${API}/bot${String(botToken).trim()}/getUpdates`, { signal: AbortSignal.timeout(15000) });
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

module.exports = { type: 'telegram', label: 'Telegram', secretFields: ['bot_token'], validate, buildRequest, send, findChats };
