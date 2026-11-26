'use strict';
/**
 * The InfluxDB connection and the metric mapping, as stored in config.
 *
 *   influx_connection  { version '1'|'2', url, database, retentionPolicy, username, password, org, bucket, token }
 *                      password and token are encrypted at rest (modules/encryption.js SECRET_FIELDS) and never sent to a page
 *   influx_mapping     [{ metric, measurement, field, tags: { key: value }, scale }]
 *                      what each Epilykos metric is called in InfluxDB, for reading its history; scale multiplies the
 *                      stored value (1000 turns kW into W)
 *   influx_write       { measurement, all } where new readings go: one measurement, the metric name as its "metric" tag;
 *                      all = every numeric reading, otherwise only the mapped metrics
 *
 * @module influx/settings
 */

const CONNECTION_KEY = 'influx_connection';
const MAPPING_KEY = 'influx_mapping';
const WRITE_KEY = 'influx_write';
const MAX_MAPPINGS = 500;
const MAX_TAGS = 10;
const NAME_MAX = 256;
const DEFAULT_MEASUREMENT = 'epilykos';

function db() { return require('../database'); }
const str = (v, max = NAME_MAX) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const CONTROL = /[\u0000-\u001f\u007f]/;
const cleanName = v => { const s = str(v); return s && !CONTROL.test(s) ? s : ''; };
const readJson = (key, fallback) => { try { const v = JSON.parse(db().getConfig(key) || ''); return v == null ? fallback : v; } catch (_) { return fallback; } };

/** A connection object with only the fields its version uses. */
function normaliseConnection(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const version = r.version === '1' ? '1' : r.version === '2' ? '2' : '';
  const base = { version, url: str(r.url, 2048) };
  if (version === '1') return { ...base, database: str(r.database), retentionPolicy: str(r.retentionPolicy), username: str(r.username), password: typeof r.password === 'string' ? r.password : '' };
  if (version === '2') return { ...base, org: str(r.org), bucket: str(r.bucket), token: typeof r.token === 'string' ? r.token.trim() : '' };
  return base;
}

function loadConnection() { return normaliseConnection(readJson(CONNECTION_KEY, {})); }

/** What a page may see: the connection without its secrets, and whether each is saved. */
function connectionView(conn = loadConnection()) {
  const { password, token, ...rest } = conn;
  return { ...rest, hasPassword: Boolean(password), hasToken: Boolean(token) };
}

/**
 * The connection to save or test from what a page sent: an empty secret keeps the saved one, as long as the server, the
 * user and the database or bucket are the same (a secret is never sent to a server it was not saved for).
 */
function mergeConnection(body, saved = loadConnection()) {
  const next = normaliseConnection({ ...saved, ...(body && typeof body === 'object' ? body : {}) });
  const same = saved.version === next.version && saved.url === next.url;
  if (next.version === '1' && !next.password && same && saved.username === next.username && saved.database === next.database) next.password = saved.password;
  if (next.version === '2' && !next.token && same && saved.org === next.org && saved.bucket === next.bucket) next.token = saved.token;
  return next;
}

function isConfigured(conn = loadConnection()) {
  if (conn.version === '1') return Boolean(conn.url && conn.database);
  if (conn.version === '2') return Boolean(conn.url && conn.org && conn.bucket && conn.token);
  return false;
}

/**
 * Check a mapping sent by a page. Returns { mapping } or { error } (the first problem, in words).
 * One row per metric: a metric reads from one series.
 */
function validateMapping(rows) {
  if (!Array.isArray(rows)) return { error: 'The mapping must be a list' };
  if (rows.length > MAX_MAPPINGS) return { error: `At most ${MAX_MAPPINGS} metrics can be mapped` };
  const seen = new Set();
  const mapping = [];
  for (const [i, row] of rows.entries()) {
    const n = i + 1;
    if (!row || typeof row !== 'object') return { error: `Row ${n} is empty` };
    const metric = cleanName(row.metric), measurement = cleanName(row.measurement), field = cleanName(row.field);
    if (!metric) return { error: `Row ${n}: choose the Epilykos metric` };
    if (!measurement || !field) return { error: `Row ${n} (${metric}): choose the measurement and the field` };
    if (seen.has(metric)) return { error: `${metric} is mapped twice` };
    seen.add(metric);
    const tagsIn = row.tags && typeof row.tags === 'object' && !Array.isArray(row.tags) ? row.tags : {};
    const tags = {};
    for (const [k, v] of Object.entries(tagsIn)) {
      const key = cleanName(k), value = cleanName(v);
      if (!key && !value) continue;
      if (!key || !value) return { error: `Row ${n} (${metric}): a tag filter needs both a name and a value` };
      tags[key] = value;
    }
    if (Object.keys(tags).length > MAX_TAGS) return { error: `Row ${n} (${metric}): at most ${MAX_TAGS} tag filters` };
    const scale = row.scale === undefined || row.scale === '' || row.scale === null ? 1 : Number(row.scale);
    if (!Number.isFinite(scale) || scale === 0) return { error: `Row ${n} (${metric}): the scale must be a number other than 0` };
    mapping.push({ metric, measurement, field, tags, scale });
  }
  return { mapping };
}

function loadMapping() {
  const v = validateMapping(readJson(MAPPING_KEY, []));
  return v.mapping || [];
}

function normaliseWrite(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { measurement: cleanName(r.measurement) || DEFAULT_MEASUREMENT, all: r.all === true };
}
function loadWrite() { return normaliseWrite(readJson(WRITE_KEY, {})); }

/**
 * Suggested mapping rows for Home Assistant's InfluxDB integration, which stores a sensor as: measurement = its unit
 * (or its entity id when it has none), tag entity_id = the entity id without its domain, field "value".
 * @param {{measurement: string, entityIds: string[]}[]} found per measurement, the entity_id tag values
 * @param {string[]} knownMetrics the metric names Epilykos already has, matched first
 */
function suggestHomeAssistant(found, knownMetrics = []) {
  const known = new Map(knownMetrics.map(m => [m.toLowerCase(), m]));
  const out = [];
  for (const { measurement, entityIds } of found) {
    for (const id of entityIds) {
      const plain = String(id).replace(/^sensor\./, '');
      const metric = known.get(plain.toLowerCase()) || known.get(`sensor.${plain}`.toLowerCase()) || plain;
      out.push({ metric, measurement, field: 'value', tags: { entity_id: id }, scale: 1, known: known.has(metric.toLowerCase()) });
    }
  }
  return out.sort((a, b) => (b.known - a.known) || a.metric.localeCompare(b.metric));
}

module.exports = {
  CONNECTION_KEY, MAPPING_KEY, WRITE_KEY, DEFAULT_MEASUREMENT, MAX_MAPPINGS,
  normaliseConnection, loadConnection, connectionView, mergeConnection, isConfigured,
  validateMapping, loadMapping, normaliseWrite, loadWrite, suggestHomeAssistant,
};
