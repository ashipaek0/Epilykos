'use strict';
/**
 * ntfy channel — JSON publish to ntfy.sh or a self-hosted server.
 * config: { server_url, topic, token, allow_private }. A server on the LAN
 * needs allow_private: the SSRF guard blocks private addresses by default.
 */

const { safeFetch } = require('../../utils');
const { postJson } = require('./http');

const PRIORITY = { info: 3, warning: 4, critical: 5 };
const TAGS = { info: ['information_source'], warning: ['warning'], critical: ['rotating_light'] };

function serverUrl(config) {
  return String(config.server_url || 'https://ntfy.sh').trim().replace(/\/+$/, '');
}

function validate(config) {
  try {
    const u = new URL(serverUrl(config));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Server URL must start with https:// or http://';
  } catch (_) { return 'Server URL is not a valid URL'; }
  if (!config.topic || !/^[\w-]{1,64}$/.test(String(config.topic).trim())) return 'Topic may use letters, numbers, - and _ (up to 64)';
  return null;
}

function buildRequest(config, msg) {
  const body = {
    topic: String(config.topic).trim(),
    title: String(msg.title || '').slice(0, 250),
    message: String(msg.body || '').slice(0, 4000),
    priority: PRIORITY[msg.severity] || 3,
    tags: TAGS[msg.severity] || [],
  };
  if (msg.url) body.click = msg.url;
  const headers = { 'Content-Type': 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${String(config.token).trim()}`;
  return { url: serverUrl(config) + '/', headers, body };
}

async function send(config, msg, deps = {}) {
  const err = validate(config);
  if (err) throw new Error(err);
  const fetchImpl = deps.fetch || ((url, init) => safeFetch(url, init, { allowPrivate: !!config.allow_private }));
  const { url, headers, body } = buildRequest(config, msg);
  await postJson(fetchImpl, url, body, { headers, label: 'ntfy', detailKey: 'error' });
}

module.exports = { type: 'ntfy', label: 'ntfy', secretFields: ['token'], validate, buildRequest, send };
