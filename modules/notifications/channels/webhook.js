'use strict';
/**
 * Generic webhook channel — POSTs the alert as JSON to any URL (Home
 * Assistant automations, n8n, Node-RED, Gotify, a script of your own).
 * config: { webhook_url, auth_header, allow_private }.
 * webhook_url is stored encrypted (it often carries a token); auth_header,
 * when set, is sent as the Authorization header ("Bearer abc…").
 */

const { safeFetch } = require('../../utils');
const { postJson } = require('./http');

function validate(config) {
  let u;
  try { u = new URL(String(config.webhook_url || '').trim()); } catch (_) { return 'Enter the URL to send to'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'URL must start with https:// or http://';
  if (config.auth_header && /[\r\n]/.test(config.auth_header)) return 'Authorization header must be one line';
  return null;
}

function buildRequest(config, msg) {
  const body = {
    source: 'epilykos',
    title: msg.title,
    message: msg.body,
    severity: msg.severity,
    tag: msg.tag || null,
    url: msg.url || null,
    timestamp: new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  if (msg.event) body.event = msg.event;
  if (msg.rule) body.rule = msg.rule;
  if (msg.metric) body.metric = msg.metric;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Epilykos' };
  if (config.auth_header) headers.Authorization = String(config.auth_header).trim();
  return { url: String(config.webhook_url).trim(), headers, body };
}

async function send(config, msg, deps = {}) {
  const err = validate(config);
  if (err) throw new Error(err);
  const fetchImpl = deps.fetch || ((url, init) => safeFetch(url, init, { allowPrivate: !!config.allow_private }));
  const { url, headers, body } = buildRequest(config, msg);
  await postJson(fetchImpl, url, body, { headers, label: 'Webhook' });
}

module.exports = { type: 'webhook', label: 'Webhook', secretFields: ['webhook_url', 'auth_header'], validate, buildRequest, send };
