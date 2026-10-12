'use strict';
/**
 * Discord channel — incoming webhook with one colour-coded embed.
 * config: { webhook_url }. Critical alerts can mention @here (mention_here).
 */

const { safeFetch } = require('../../utils');

const COLOR = { info: 0x3b82f6, warning: 0xf59e0b, critical: 0xdc2626 };
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

function validate(config) {
  if (!config.webhook_url || !WEBHOOK_RE.test(String(config.webhook_url).trim())) return 'Webhook URL must look like https://discord.com/api/webhooks/…';
  return null;
}

function buildRequest(config, msg) {
  const embed = {
    title: String(msg.title || '').slice(0, 256),
    description: String(msg.body || '').slice(0, 4000),
    color: COLOR[msg.severity] || COLOR.info,
    timestamp: new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    footer: { text: 'Epilykos' },
  };
  if (msg.url) embed.url = msg.url;
  const body = { username: 'Epilykos', embeds: [embed], allowed_mentions: { parse: [] } };
  if (config.mention_here && msg.severity === 'critical') {
    body.content = '@here';
    body.allowed_mentions = { parse: ['everyone'] };
  }
  return { url: String(config.webhook_url).trim(), body };
}

async function send(config, msg, deps = {}) {
  const err = validate(config);
  if (err) throw new Error(err);
  const fetchImpl = deps.fetch || safeFetch;
  const { url, body } = buildRequest(config, msg);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    // Name the host, never the URL (Telegram's and Discord's carry the secret).
    throw new Error(`Could not reach ${new URL(url).host}: ${e.message}`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (_) { /* not JSON */ }
    throw new Error(`Discord ${res.status}${detail ? ': ' + detail : ''}`);
  }
}

module.exports = { type: 'discord', label: 'Discord', secretFields: ['webhook_url'], validate, buildRequest, send };
