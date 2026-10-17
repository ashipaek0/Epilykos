'use strict';
// Tiny HTTP client for the security attack scripts: real requests, full
// control of headers and cookies, no browser. BASE_URL defaults to the local
// test server. Every call records { method, path, status, body, set-cookie }.
const http = require('http');
const { URL } = require('url');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';

function request(method, path, { body, headers = {}, cookie, raw = false } = {}) {
  const u = new URL(path, BASE);
  const payload = (body === undefined || body === null) ? null
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...headers };
  if (payload != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (payload != null) h['Content-Length'] = Buffer.byteLength(payload);
  if (cookie) h['Cookie'] = cookie;
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

// Log in and return the session cookie string (name=value; ...).
async function login(password = process.env.TEST_PASSWORD || 'testpass1234') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await request('POST', '/api/login', { body: { password }, headers: xhr });
    if (r.status === 200) return r.setCookie.map(c => c.split(';')[0]).join('; ');
    if (r.status === 429 && attempt === 0) {
      // Login rate-limiter (10/min) is engaged — wait out the window and retry once.
      const reset = parseInt(r.headers['ratelimit-reset'], 10);
      await new Promise(res => setTimeout(res, (Number.isFinite(reset) ? Math.min(reset, 65) : 62) * 1000));
      continue;
    }
    throw new Error(`login failed: ${r.status} ${r.text}`);
  }
}

module.exports = { request, login, xhr, BASE };
