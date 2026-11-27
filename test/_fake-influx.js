'use strict';
// A fake InfluxDB (1.x or 2.x) for tests. It does not run queries: each request is logged, and the answer comes from
// `answer(kind, query, req)` supplied by the test (kind: 'ql' for /query, 'flux' for /api/v2/query). Writes are kept as lines.
// Auth: 1.x Basic user/password when `user` is set; 2.x "Token <token>".
const http = require('node:http');

function createFakeInflux({ version = '2', token = 'tok', user, password, answer = () => null } = {}) {
  const log = [];        // { method, path, params, query, auth }
  const written = [];    // line-protocol lines
  const state = { failWrites: 0, writeStatus: 503, delayMs: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const reply = (code, text = '', type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(text); };
      const params = Object.fromEntries(u.searchParams);
      const auth = req.headers.authorization || '';
      const entry = { method: req.method, path: u.pathname, params, auth, body };
      log.push(entry);
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      if (version === '2') {
        if (auth !== `Token ${token}`) return reply(401, JSON.stringify({ code: 'unauthorized', message: 'unauthorized access' }));
      } else if (user && auth !== 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')) {
        return reply(401, JSON.stringify({ error: 'authorization failed' }));
      }
      if (u.pathname === '/query' && version === '1') {
        entry.query = params.q;
        const out = answer('ql', params.q, entry);
        if (out && out.status) return reply(out.status, out.body || '');
        return reply(200, JSON.stringify(out || { results: [{ statement_id: 0 }] }));
      }
      if (u.pathname === '/api/v2/query' && version === '2') {
        let q = '';
        try { q = JSON.parse(body).query; } catch (_) { q = body; }
        entry.query = q;
        const out = answer('flux', q, entry);
        if (out && out.status) return reply(out.status, out.body || '');
        return reply(200, out || '', 'text/csv');
      }
      if ((u.pathname === '/write' && version === '1') || (u.pathname === '/api/v2/write' && version === '2')) {
        if (state.failWrites > 0) { state.failWrites--; return reply(state.writeStatus, JSON.stringify({ message: 'unavailable' })); }
        for (const line of body.split('\n')) if (line) written.push(line);
        return reply(204);
      }
      reply(404, JSON.stringify({ message: 'not found' }));
    });
  });
  return {
    log, written, state,
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(r => server.close(r)),
  };
}

/** Flux CSV (header row, no annotations) from rows of objects; the columns come from the first row. */
function fluxCsv(rows) {
  if (!rows.length) return '';
  const cols = ['', 'result', 'table', ...Object.keys(rows[0])];
  const cell = v => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => ['', '_result', 0, ...Object.keys(rows[0]).map(k => r[k])].map(cell).join(','))].join('\r\n') + '\r\n\r\n';
}

/** An InfluxQL answer with one series. */
function qlAnswer(columns, values, name = 'm') {
  return { results: [{ statement_id: 0, series: [{ name, columns, values }] }] };
}

/** A fetch that sends every request to the fake, ignoring the SSRF guard (the fake listens on loopback, which the guard refuses). */
const directFetch = (url, init) => fetch(url, init);

module.exports = { createFakeInflux, fluxCsv, qlAnswer, directFetch };
