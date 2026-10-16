'use strict';
/**
 * Settings → Logs. Signed-in only (mounted behind isAuthenticated).
 *
 *   GET  /api/logs                 recent lines (after=<seq>, level, source, q)
 *   POST /api/logs/level           { level } change it now; debug turns itself
 *                                  back after 30 minutes
 *   GET  /api/logs/download        the kept lines as a text file
 *   GET  /api/logs/diagnostics     one file to send when asking for help:
 *                                  versions, settings with secrets removed,
 *                                  recent lines
 */
const express = require('express');
const os = require('os');
const { logger, setLevel, LEVELS, envLevel } = require('../modules/logger');
const logBuffer = require('../modules/logBuffer');
const { getConfig, setConfig, getDb } = require('../modules/database');
const { SECRET_FIELDS } = require('../modules/encryption');

const DEBUG_MINUTES = 30;
// Fields that look secret even if not in SECRET_FIELDS (diagnostics only).
const SECRET_KEY = /token|password|passwd|secret|api_?key|local_?key|access_?key|private_?key|auth|webhook_?url|session/i;

let revertTimer = null;
let revertAt = null;

/** The level saved in Settings (or LOG_LEVEL), never a temporary debug. */
function baseLevel() {
  const saved = getConfig('log_level');
  return LEVELS.includes(saved) ? saved : (LEVELS.includes(envLevel) ? envLevel : 'info');
}

function applyLevel(level) {
  setLevel(level);
  try { require('../modules/ble').setLogLevel(level); } catch (_) { /* no Bluetooth */ }
}

function changeLevel(level) {
  clearTimeout(revertTimer); revertTimer = null; revertAt = null;
  if (level === 'debug') {
    // Debug is loud (and wears SD cards): back to the saved level after a while.
    revertAt = Date.now() + DEBUG_MINUTES * 60 * 1000;
    revertTimer = setTimeout(() => {
      revertTimer = null; revertAt = null;
      const back = baseLevel();
      applyLevel(back);
      logger.info(`[logs] Debug logging ended after ${DEBUG_MINUTES} minutes; back to ${back}`);
    }, DEBUG_MINUTES * 60 * 1000);
    if (typeof revertTimer.unref === 'function') revertTimer.unref();
  } else {
    setConfig('log_level', level);
  }
  applyLevel(level);
  logger.info(`[logs] Log level set to ${level}${revertAt ? ` until ${new Date(revertAt).toLocaleTimeString()}` : ''}`);
}

/** Every configured secret value, to hide wherever it appears in a line. */
function secretValues() {
  const out = [];
  if (process.env.SETTINGS_PASSWORD) out.push(process.env.SETTINGS_PASSWORD);
  for (const [key, leaves] of Object.entries(SECRET_FIELDS)) {
    let raw;
    try { raw = getConfig(key); } catch (_) { continue; }
    if (!raw) continue;
    if (!leaves.length) { out.push(String(raw)); continue; }
    let parsed; try { parsed = JSON.parse(raw); } catch (_) { continue; }
    (function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (leaves.includes(k) && v != null && typeof v !== 'object') out.push(String(v));
        else walk(v);
      }
    })(parsed);
  }
  return out;
}

function refreshSecrets() {
  try { logBuffer.setSecretValues(secretValues()); } catch (e) { logger.debug(`[logs] could not read secrets: ${e.message}`); }
}

/** Settings for the diagnostics file: secret fields replaced, big values cut. */
function redactedConfig() {
  const rows = getDb().prepare('SELECT key FROM config ORDER BY key').all();
  const out = {};
  const mask = (node, leaves) => {
    if (Array.isArray(node)) return node.map(n => mask(n, leaves));
    if (!node || typeof node !== 'object') return node;
    const copy = {};
    for (const [k, v] of Object.entries(node)) copy[k] = (leaves.includes(k) || SECRET_KEY.test(k)) && v !== '' && v != null ? '[hidden]' : mask(v, leaves);
    return copy;
  };
  for (const { key } of rows) {
    if (SECRET_KEY.test(key) && !(key in SECRET_FIELDS && SECRET_FIELDS[key].length)) { out[key] = '[hidden]'; continue; }
    let value = getConfig(key);
    if (value && /^[[{]/.test(value)) { try { value = mask(JSON.parse(value), SECRET_FIELDS[key] || []); } catch (_) { /* plain text */ } }
    if (typeof value === 'string') value = logBuffer.redact(value.length > 20000 ? value.slice(0, 20000) + ' …' : value);
    out[key] = value;
  }
  return out;
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

function router() {
  const r = express.Router();

  r.get('/', (req, res) => {
    refreshSecrets();
    const after = parseInt(req.query.after, 10) || 0;
    const result = logBuffer.read({
      after,
      level: LEVELS.includes(req.query.level) ? req.query.level : '',
      source: typeof req.query.source === 'string' ? req.query.source.slice(0, 40) : '',
      q: typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '',
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000),
    });
    result.entries = result.entries.map(e => ({ ...e, message: logBuffer.redact(e.message) }));
    res.json({ ...result, sources: logBuffer.sources(), level: logger.level, baseLevel: baseLevel(), envLevel, revertAt, levels: LEVELS, capacity: logBuffer.CAPACITY });
  });

  r.post('/level', express.json(), (req, res) => {
    const level = req.body && req.body.level;
    if (!LEVELS.includes(level)) return res.status(400).json({ error: `Level must be one of ${LEVELS.join(', ')}` });
    changeLevel(level);
    res.json({ level: logger.level, baseLevel: baseLevel(), revertAt });
  });

  r.get('/download', (req, res) => {
    refreshSecrets();
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="epilykos-log-${stamp()}.txt"`);
    res.send(logBuffer.redact(logBuffer.asText()));
  });

  r.get('/diagnostics', (req, res) => {
    refreshSecrets();
    const version = require('../modules/version').appVersion();
    const recent = logBuffer.read({ limit: 2000 }).entries;
    const body = {
      generatedAt: new Date().toISOString(),
      note: 'Secrets (tokens, passwords, keys) are replaced with [hidden].',
      app: { version, node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, uptimeSeconds: Math.round(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1048576), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      logLevel: { current: logger.level, saved: baseLevel(), env: envLevel, debugUntil: revertAt ? new Date(revertAt).toISOString() : null },
      settings: redactedConfig(),
      log: logBuffer.redact(logBuffer.asText(recent)).split('\n').filter(Boolean),
    };
    res.set('Content-Disposition', `attachment; filename="epilykos-diagnostics-${stamp()}.json"`);
    res.type('application/json').send(JSON.stringify(body, null, 2));
  });

  return r;
}

/** At startup: the saved level (if any) and the current secrets. */
function init() {
  const saved = getConfig('log_level');
  if (LEVELS.includes(saved) && saved !== logger.level) applyLevel(saved);
  else if (logger.level === 'debug') applyLevel('debug');   // LOG_LEVEL=debug reaches the Bluetooth helper too
  refreshSecrets();
}

module.exports = { router, init, changeLevel, secretValues, redactedConfig, _state: () => ({ revertAt }) };
