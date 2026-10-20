'use strict';
// Tiny HTTP client for the security attack scripts: real requests, full
// control of headers and cookies, no browser. BASE_URL defaults to the local
// test server. Every call records { method, path, status, body, set-cookie }.
const http = require('http');
const { URL } = require('url');

const csrfTokens = new Map();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';

function request(method, path, { body, headers = {}, cookie, raw = false } = {}) {
  const u = new URL(path, BASE);
  const payload = (body === undefined || body === null) ? null
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...headers };
  if (payload != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (payload != null) h['Content-Length'] = Buffer.byteLength(payload);
  if (cookie) h['Cookie'] = cookie;
  if (cookie && csrfTokens.has(cookie) && h['X-Requested-With'] === 'XMLHttpRequest' && !h['X-CSRF-Token']) h['X-CSRF-Token'] = csrfTokens.get(cookie);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        if (!raw) { try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; } }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

// Explicit opt-in: negative CSRF probes must still be able to omit the token.
async function anonymousSession() {
  const r = await request('GET', '/api/csrf-token');
  if (r.status !== 200 || typeof r.body.token !== 'string') throw new Error('CSRF bootstrap failed');
  return { cookie: r.setCookie.map(c => c.split(';')[0]).join('; '), headers: { ...xhr, 'X-CSRF-Token': r.body.token } };
}

// Log in and return the session cookie string (name=value; ...).
async function login(password = process.env.TEST_PASSWORD || 'testpass1234') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const bootstrap = await request('GET', '/api/csrf-token');
    const cookie = bootstrap.setCookie.map(c => c.split(';')[0]).join('; ');
    const token = bootstrap.body.token;
    const r = await request('POST', '/api/login', { body: { password }, cookie, headers: { ...xhr, 'X-CSRF-Token': token } });
    if (r.status === 200) {
      const authenticatedCookie = r.setCookie.length ? r.setCookie.map(c => c.split(';')[0]).join('; ') : cookie;
      csrfTokens.set(authenticatedCookie, token);
      return authenticatedCookie;
    }
    if (r.status === 429 && attempt === 0) {
      // Login rate-limiter (10/min) is engaged — wait out the window and retry once.
      const reset = parseInt(r.headers['ratelimit-reset'], 10);
      await new Promise(res => setTimeout(res, (Number.isFinite(reset) ? Math.min(reset, 65) : 62) * 1000));
      continue;
    }
    throw new Error(`login failed: ${r.status} ${r.text}`);
  }
}

module.exports = { request, login, anonymousSession, xhr, BASE };
