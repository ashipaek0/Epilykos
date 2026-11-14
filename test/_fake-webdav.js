'use strict';
// A small in-memory WebDAV server for tests: Basic auth, PROPFIND (Depth 0 and 1), MKCOL, PUT, GET, DELETE, an optional cap on
// the size of a request (413 above it, like a reverse proxy would), and failures on demand. Collections are paths ending in "/".
const http = require('node:http');
const https = require('node:https');

function createFakeWebdav({ user = 'ade', password = 'app-password', root = '/dav/', maxBody = Infinity, tls } = {}) {
  const files = new Map();                 // path → Buffer
  const dirs = new Set([root.replace(/\/$/, ''), '']);
  const log = [];
  const state = { failPut: [], failGet: [], redirect: false };
  const handler = (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/+$/, '');
    log.push(req.method + ' ' + path);
    const reply = (code, body = '', headers = {}) => { res.writeHead(code, { 'Content-Length': Buffer.byteLength(body), ...headers }); res.end(body); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')) return reply(401, '', { 'WWW-Authenticate': 'Basic realm="dav"' });
    if (state.redirect) return reply(301, '', { Location: 'https://elsewhere.example/dav/' });
    const parentOf = p => p.slice(0, p.lastIndexOf('/'));
    if (req.method === 'PROPFIND') {
      if (!dirs.has(path) && !files.has(path)) return reply(404);
      const depth = req.headers.depth === '0' ? 0 : 1;
      const entries = [`<d:response><d:href>${path}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`];
      if (depth === 1 && dirs.has(path)) {
        for (const d of dirs) if (d && d !== path && parentOf(d) === path) entries.push(`<d:response><d:href>${encodeURI(d)}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`);
        for (const [f, b] of files) if (parentOf(f) === path) entries.push(`<d:response><d:href>${encodeURI(f)}</d:href><d:propstat><d:prop><d:getcontentlength>${b.length}</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>`);
      }
      return reply(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`, { 'Content-Type': 'application/xml' });
    }
    if (req.method === 'MKCOL') {
      if (dirs.has(path)) return reply(405);
      if (!dirs.has(parentOf(path))) return reply(409);
      dirs.add(path); return reply(201);
    }
    if (req.method === 'PUT') {
      if (Number(req.headers['content-length'] || 0) > maxBody) { req.resume(); return reply(413); }
      const chunks = []; req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const fail = state.failPut.find(f => path.endsWith(f.suffix) && f.times > 0);
        if (fail) { fail.times--; return reply(fail.status || 503); }
        if (!dirs.has(parentOf(path))) return reply(409);
        files.set(path, Buffer.concat(chunks)); reply(201);
      });
      return;
    }
    if (req.method === 'GET') {
      const fail = state.failGet.find(f => path.endsWith(f.suffix) && f.times > 0);
      if (fail) { fail.times--; return reply(fail.status || 503); }
      return files.has(path) ? reply(200, files.get(path)) : reply(404);
    }
    if (req.method === 'DELETE') { files.delete(path); return reply(204); }
    reply(405);
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  return {
    files, dirs, log, state, server,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}${root}`))),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })
  };
}
module.exports = { createFakeWebdav };
