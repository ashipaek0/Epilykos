'use strict';
/**
 * A small client for the InfluxDB a user already has: 1.x (InfluxQL over /query and /write) or 2.x (Flux over
 * /api/v2/query, /api/v2/write). One interface for both, so the import and the writer never ask which one it is.
 *
 * Connection settings:
 *   1.x  { version: '1', url, database, retentionPolicy?, username?, password? }
 *   2.x  { version: '2', url, org, bucket, token }
 *
 * The server is usually on the user's own network, so private (LAN) addresses are allowed; loopback, link-local and
 * cloud-metadata addresses are not (modules/utils.js assertSafeFetchUrl with allowPrivate). Secrets never appear in an
 * error message.
 *
 * @module influx/client
 */

const { safeFetch, trimSlashes } = require('../utils');
const { influxql, flux } = require('./queries');

const QUERY_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 15_000;
const MAX_ERROR_TEXT = 300;

class InfluxError extends Error {
  constructor(message, { status, kind } = {}) { super(message); this.name = 'InfluxError'; this.status = status; this.kind = kind; }
}

/** Parse CSV as Flux returns it (header row per table, tables separated by blank lines, RFC 4180 quoting). */
function parseFluxCsv(text) {
  const rows = [];
  let header = null;
  let field = '', record = [], inQuotes = false, i = 0;
  const endRecord = () => {
    record.push(field); field = '';
    const blank = record.length === 1 && record[0] === '';
    if (blank) header = null;
    else if (record[0] && record[0].startsWith('#')) { /* annotation row: not asked for, skipped if present */ }
    else if (!header) header = record;
    else if (record.join('') !== header.join('')) {
      const obj = {};
      header.forEach((name, j) => { if (name) obj[name] = record[j]; });
      rows.push(obj);
    }
    record = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') endRecord();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || record.length) endRecord();
  return rows;
}

const toSeconds = t => {
  if (typeof t === 'number') return Math.floor(t);
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

function validate(conf) {
  if (!conf || (conf.version !== '1' && conf.version !== '2')) throw new InfluxError('Choose InfluxDB 1.x or 2.x', { kind: 'config' });
  let u;
  try { u = new URL(conf.url); } catch (_) { throw new InfluxError('The server address is not a URL', { kind: 'config' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InfluxError('The server address must start with http:// or https://', { kind: 'config' });
  if (u.username || u.password) throw new InfluxError('Put the user name and password in their own fields, not in the address', { kind: 'config' });
  if (conf.version === '1' && !conf.database) throw new InfluxError('Enter the database name', { kind: 'config' });
  if (conf.version === '2' && (!conf.org || !conf.bucket || !conf.token)) throw new InfluxError('Enter the organisation, bucket and token', { kind: 'config' });
}

/**
 * @param {object} conf connection settings (see the module comment)
 * @param {{fetchImpl?: Function}} [options] fetchImpl(url, init) for tests; the default is the SSRF-guarded fetch
 */
function createInfluxClient(conf, { fetchImpl } = {}) {
  validate(conf);
  const base = trimSlashes(conf.url);
  const doFetch = fetchImpl || ((url, init) => safeFetch(url, init, { allowPrivate: true, maxRedirects: 0 }));
  const v2 = conf.version === '2';

  const authHeaders = () => {
    if (v2) return { Authorization: `Token ${conf.token}` };
    if (conf.username) return { Authorization: 'Basic ' + Buffer.from(`${conf.username}:${conf.password || ''}`).toString('base64') };
    return {};
  };

  async function request(path, params, init, timeoutMs) {
    const url = `${base}${path}?${new URLSearchParams(params)}`;
    let res;
    try {
      res = await doFetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new InfluxError(timedOut ? 'InfluxDB did not answer in time' : `Could not reach InfluxDB: ${err.message}`, { kind: timedOut ? 'timeout' : 'network' });
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new InfluxError(v2 ? 'InfluxDB refused the token' : 'InfluxDB refused the user name or password', { status: res.status, kind: 'auth' });
    if (res.status >= 300 && res.status < 400) throw new InfluxError('InfluxDB answered with a redirect; enter the address it redirects to', { status: res.status, kind: 'http' });
    if (!res.ok) {
      let message = text;
      try { const j = JSON.parse(text); message = j.message || j.error || text; } catch (_) { /* plain text */ }
      throw new InfluxError(`InfluxDB: ${String(message).slice(0, MAX_ERROR_TEXT) || `HTTP ${res.status}`}`, { status: res.status, kind: res.status === 429 ? 'rate' : 'http' });
    }
    return text;
  }

  // ── 1.x ──
  async function ql(q) {
    const params = { db: conf.database, q, epoch: 's' };
    if (conf.retentionPolicy) params.rp = conf.retentionPolicy;
    const text = await request('/query', params, { method: 'POST', headers: { Accept: 'application/json' } }, QUERY_TIMEOUT_MS);
    let body;
    try { body = JSON.parse(text); } catch (_) { throw new InfluxError('InfluxDB sent an answer that is not JSON', { kind: 'http' }); }
    const result = (body.results || [])[0] || {};
    if (result.error) throw new InfluxError(`InfluxDB: ${String(result.error).slice(0, MAX_ERROR_TEXT)}`, { kind: 'query' });
    // Rows as objects keyed by column, across every series of the answer.
    const rows = [];
    for (const s of result.series || []) for (const v of s.values || []) {
      const row = {};
      s.columns.forEach((c, j) => { row[c] = v[j]; });
      rows.push(row);
    }
    return rows;
  }

  // ── 2.x ──
  async function fx(query) {
    const text = await request('/api/v2/query', { org: conf.org }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/csv' },
      body: JSON.stringify({ query, type: 'flux', dialect: { header: true, annotations: [] } }),
    }, QUERY_TIMEOUT_MS);
    const rows = parseFluxCsv(text);
    const err = rows.find(r => r.error);
    if (err) throw new InfluxError(`InfluxDB: ${String(err.error).slice(0, MAX_ERROR_TEXT)}`, { kind: 'query' });
    return rows;
  }

  const names = (rows, column) => [...new Set(rows.map(r => r[column]).filter(v => typeof v === 'string' && v))].sort();

  return {
    version: conf.version,

    /** Check the address, the credentials and the database or bucket. Resolves to { ok: true } or throws an InfluxError. */
    async test() {
      if (v2) {
        const rows = await fx(flux.bucketExists(conf.bucket));
        if (!rows.length) throw new InfluxError(`There is no bucket "${conf.bucket}" that this token can read`, { kind: 'config' });
      } else {
        await ql('SHOW MEASUREMENTS LIMIT 1');
      }
      return { ok: true };
    },

    async measurements() {
      return v2 ? names(await fx(flux.measurements(conf.bucket)), '_value') : names(await ql(influxql.measurements()), 'name');
    },

    /** [{ name, type }]; type is InfluxDB's (float, integer, string, boolean) where it says, else null. */
    async fieldKeys(measurement) {
      if (v2) return names(await fx(flux.fieldKeys(conf.bucket, measurement)), '_value').map(name => ({ name, type: null }));
      return (await ql(influxql.fieldKeys(measurement))).map(r => ({ name: r.fieldKey, type: r.fieldType || null })).filter(f => f.name);
    },

    async tagKeys(measurement) {
      return v2 ? names(await fx(flux.tagKeys(conf.bucket, measurement)), '_value').filter(k => !k.startsWith('_'))
        : names(await ql(influxql.tagKeys(measurement)), 'tagKey');
    },

    async tagValues(measurement, key) {
      return v2 ? names(await fx(flux.tagValues(conf.bucket, measurement, key)), '_value')
        : names(await ql(influxql.tagValues(measurement, key)), 'value');
    },

    /** The time (seconds) of a series' first reading, or null when it has none. */
    async first(series) {
      const rows = v2 ? await fx(flux.first(conf.bucket, series)) : await ql(influxql.first(series, conf));
      return rows.length ? toSeconds(v2 ? rows[0]._time : rows[0].time) : null;
    },

    /**
     * 5-minute buckets of a series over [from, to) (seconds): [{ bucket_start, avg, min, max, count }], oldest first.
     * A bucket with no numeric readings is left out.
     */
    async buckets(series, from, to) {
      const out = new Map();
      if (v2) {
        for (const r of await fx(flux.buckets(conf.bucket, series, from, to))) {
          const t = toSeconds(r._time), v = Number(r._value);
          if (t === null || r._value === '' || !Number.isFinite(v)) continue;
          if (!out.has(t)) out.set(t, { bucket_start: t });
          out.get(t)[r.agg] = v;
        }
      } else {
        for (const r of await ql(influxql.buckets(series, from, to, conf))) {
          const t = toSeconds(r.time);
          if (t !== null) out.set(t, { bucket_start: t, avg: r.avg, min: r.min, max: r.max, count: r.count });
        }
      }
      return [...out.values()]
        .filter(b => [b.avg, b.min, b.max].every(Number.isFinite) && Number.isFinite(b.count) && b.count > 0)
        .map(b => ({ ...b, count: Math.round(b.count) }))
        .sort((a, b) => a.bucket_start - b.bucket_start);
    },

    /** Write line-protocol lines (second precision). */
    async write(lines) {
      if (!lines.length) return;
      const body = lines.join('\n');
      const init = { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body };
      if (v2) await request('/api/v2/write', { org: conf.org, bucket: conf.bucket, precision: 's' }, init, WRITE_TIMEOUT_MS);
      else {
        const params = { db: conf.database, precision: 's' };
        if (conf.retentionPolicy) params.rp = conf.retentionPolicy;
        await request('/write', params, init, WRITE_TIMEOUT_MS);
      }
    },
  };
}

module.exports = { createInfluxClient, InfluxError, parseFluxCsv };
