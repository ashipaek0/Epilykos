'use strict';
/**
 * Discord channel — incoming webhook with one colour-coded embed.
 * config: { webhook_url }. Critical alerts can mention @here (mention_here).
 */

const { safeFetch } = require('../../utils');
const { postJson } = require('./http');

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
  const { url, body } = buildRequest(config, msg);
  await postJson(deps.fetch || safeFetch, url, body, { label: 'Discord', detailKey: 'message' });
}

module.exports = { type: 'discord', label: 'Discord', secretFields: ['webhook_url'], validate, buildRequest, send };
