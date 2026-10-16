'use strict';
/**
 * The last few thousand log lines, kept in memory for Settings → Logs.
 *
 * Fed by a winston transport (see logger.js) and by console.log/warn/error,
 * which a few modules still use. Works with LOG_TO_FILE=false (read-only
 * EpilykosOS), where there is no log file to read.
 *
 * Secrets are removed before a line is stored, so the page, the download and
 * the diagnostics file are safe to share: configured secret values (tokens,
 * passwords, keys from the settings) and common token shapes.
 */
const util = require('util');
const { Transport } = require('winston');

const CAPACITY = 5000;
const MAX_MESSAGE = 4000;

let entries = [];      // { seq, ts, level, source, message }
let seq = 0;
let secretValues = []; // longest first, so a secret containing another is hidden whole

const PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [hidden]'],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[hidden token]'],                         // Telegram bot token
  [/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[hidden]@'],                       // user:pass@ in URLs
  [/((?:token|password|passwd|secret|api[_-]?key|local[_-]?key|access[_-]?key|auth)["']?\s*[:=]\s*["']?)[^\s"',&}]{4,}/gi, '$1[hidden]'],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '[hidden token]'], // JWT
];

function redact(text) {
  let out = String(text);
  for (const secret of secretValues) if (out.includes(secret)) out = out.split(secret).join('[hidden]');
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
  return out;
}

/** Values to hide wherever they appear (from the saved settings). Short ones would hide ordinary words. */
function setSecretValues(values) {
  secretValues = [...new Set((values || []).map(v => String(v || '')).filter(v => v.length >= 6))].sort((a, b) => b.length - a.length);
}

const SOURCE_TAG = /^\s*\[([A-Za-z0-9_ ./-]{1,24})\]/;
const SOURCE_WORD = /^\s*(BMS-wired|BMS|Tuya|Modbus|RS232|MQTT|HA|Poll(?:ing)?|Snapshot|Settings|PVOutput|Telegram|Energy dashboard)\b/i;
function sourceOf(message, meta) {
  if (meta && typeof meta.module === 'string') return meta.module;
  const tag = SOURCE_TAG.exec(message);
  if (tag) return tag[1].split('/')[0].trim().toLowerCase();
  const word = SOURCE_WORD.exec(message);
  if (word) return word[1].toLowerCase().replace(/^poll(ing)?$/, 'polling').replace('energy dashboard', 'app');
  return 'app';
}

function add(level, message, meta) {
  let text = typeof message === 'string' ? message : util.inspect(message, { depth: 3, breakLength: Infinity });
  if (meta && meta.stack && !text.includes(meta.stack)) text += `\n${meta.stack}`;
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE) + ' …';
  entries.push({ seq: ++seq, ts: Date.now(), level, source: level === 'http' ? 'web' : sourceOf(text, meta), message: redact(text) });
  if (entries.length > CAPACITY) entries = entries.slice(entries.length - CAPACITY);
}

/** winston transport: every line the logger emits at its current level. */
class BufferTransport extends Transport {
  log(info, callback) {
    const { level, message, timestamp, ...meta } = info;
    add(String(level).replace(/\u001b\[[0-9;]*m/g, ''), message, meta);
    callback();
  }
}

/**
 * Also keep console.log/info/warn/error output (some modules print directly).
 * winston's Console transport writes to the stream itself, not through these,
 * so nothing is stored twice.
 */
let consoleHooked = false;
function captureConsole() {
  if (consoleHooked) return;
  consoleHooked = true;
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      try { add(level, util.format(...args)); } catch (_) { /* never break console output */ }
      original(...args);
    };
  }
}

const LEVEL_RANK = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 };

/**
 * Lines after `after` (a seq), newest last. level: the least severe level to
 * include ('warn' = warnings and errors). source and q filter further.
 */
function read({ after = 0, level = '', source = '', q = '', limit = 500 } = {}) {
  const maxRank = LEVEL_RANK[level] ?? 6;
  const needle = String(q || '').toLowerCase();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (e.seq <= after) break;
    if ((LEVEL_RANK[e.level] ?? 6) > maxRank) continue;
    if (source && e.source !== source) continue;
    if (needle && !e.message.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return { entries: out.reverse(), lastSeq: seq, firstSeq: entries.length ? entries[0].seq : seq };
}

function sources() { return [...new Set(entries.map(e => e.source))].sort(); }

/** Plain text, one line per entry, for downloads. */
function asText(list = entries) {
  return list.map(e => `${new Date(e.ts).toISOString()} [${e.level}] ${e.message}`).join('\n') + '\n';
}

function _reset() { entries = []; seq = 0; secretValues = []; }

module.exports = { BufferTransport, captureConsole, add, read, sources, asText, redact, setSecretValues, LEVEL_RANK, CAPACITY, _reset };
