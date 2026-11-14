'use strict';
// A small in-memory stand-in for the parts of Google used by the Drive backup: the device sign-in, token renewal and revocation,
// and the Drive v3 calls (folder search and creation, listing, resumable upload with 308 progress and status queries, download,
// delete). Failures can be injected: a chunk that fails after Google kept part of it, a full Drive, an expired access token.
const http = require('node:http');
const crypto = require('node:crypto');

function createFakeGoogle({ clientId = 'client-1', clientSecret = 'secret-1', accessLifetime = 3600 } = {}) {
  const state = { approved: false, denied: false, slowDown: 0, revoked: false, quotaFull: false, failChunks: [], accessLifetime, expireAccess: false };
  const tokens = new Map();                 // access token → expiry
  const files = new Map();                  // id → { id, name, mimeType, parents, appProperties, content }
  const sessions = new Map();
  const log = [];
  let base = '';
  const id = () => crypto.randomBytes(8).toString('hex');
  const read = req => new Promise(resolve => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });

  function matches(file, q) {
    const parent = /'([^']+)' in parents/.exec(q); if (parent && !(file.parents || []).includes(parent[1]) && !(parent[1] === 'root' && (file.parents || []).length === 0)) return false;
    const eq = /name = '((?:[^'\\]|\\.)*)'/.exec(q); if (eq && file.name !== eq[1].replace(/\\(.)/g, '$1')) return false;
    const has = /name contains '([^']*)'/.exec(q); if (has && !file.name.includes(has[1])) return false;
    const mime = /mimeType = '([^']*)'/.exec(q); if (mime && file.mimeType !== mime[1]) return false;
    return !file.trashed;
  }
  const publicFile = f => ({ id: f.id, name: f.name, mimeType: f.mimeType, trashed: Boolean(f.trashed), appProperties: f.appProperties, ...(f.content ? { size: String(f.content.length), md5Checksum: crypto.createHash('md5').update(f.content).digest('hex') } : {}) });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => { const text = body === undefined ? '' : (Buffer.isBuffer(body) ? body : JSON.stringify(body)); res.writeHead(code, { 'Content-Length': Buffer.byteLength(text), ...(Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }), ...headers }); res.end(text); };
    log.push(`${req.method} ${url.pathname}`);
    const body = await read(req);
    if (url.pathname === '/device/code') {
      const f = new URLSearchParams(body.toString());
      if (f.get('client_id') !== clientId) return send(401, { error: 'invalid_client' });
      return send(200, { device_code: 'dev-1', user_code: 'KQRT-WZVM', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5, scope: f.get('scope') });
    }
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body.toString());
      if (f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return send(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'refresh_token') {
        if (state.revoked || f.get('refresh_token') !== 'refresh-1') return send(400, { error: 'invalid_grant' });
        const access = 'access-' + id(); tokens.set(access, Date.now() + state.accessLifetime * 1000);
        return send(200, { access_token: access, expires_in: state.accessLifetime, token_type: 'Bearer' });
      }
      if (state.denied) return send(403, { error: 'access_denied' });
      if (state.slowDown > 0) { state.slowDown--; return send(403, { error: 'slow_down' }); }
      if (!state.approved) return send(428, { error: 'authorization_pending' });
      const access = 'access-' + id(); tokens.set(access, Date.now() + state.accessLifetime * 1000);
      return send(200, { access_token: access, refresh_token: 'refresh-1', expires_in: state.accessLifetime, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' });
    }
    if (url.pathname === '/revoke') { state.revoked = true; return send(200, {}); }
    // Everything below needs a live access token.
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const expiry = bearer && tokens.get(bearer[1]);
    if (url.pathname.startsWith('/upload/') && req.method === 'PUT') { /* the session address carries its own authority */ }
    else if (!expiry || state.expireAccess || expiry < Date.now()) return send(401, { error: { code: 401, message: 'Invalid Credentials' } });

    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      return send(200, { files: [...files.values()].filter(f => matches(f, q)).map(publicFile) });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString()); const f = { id: id(), parents: [], ...meta }; files.set(f.id, f); return send(200, publicFile(f));
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const f = files.get(one[1]);
      if (!f) return send(404, { error: { code: 404, message: 'File not found' } });
      if (req.method === 'DELETE') { files.delete(f.id); return send(204); }
      if (url.searchParams.get('alt') === 'media') return send(200, f.content, { 'Content-Type': 'application/octet-stream' });
      return send(200, publicFile(f));
    }
    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      if (state.quotaFull) return send(403, { error: { code: 403, message: 'The user storage quota has been exceeded.', errors: [{ reason: 'storageQuotaExceeded' }] } });
      const meta = JSON.parse(body.toString()); const sid = id();
      sessions.set(sid, { meta, total: Number(req.headers['x-upload-content-length']), chunks: [], received: 0 });
      return send(200, {}, { Location: `${base}/upload/session/${sid}` });
    }
    const sess = /^\/upload\/session\/([^/]+)$/.exec(url.pathname);
    if (sess && req.method === 'PUT') {
      const s = sessions.get(sess[1]); if (!s) return send(404, {});
      const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(req.headers['content-range'] || '');
      if (!range) return send(400, {});
      const complete = () => { const f = { id: id(), parents: [], ...s.meta, content: Buffer.concat(s.chunks) }; files.set(f.id, f); return send(200, publicFile(f)); };
      if (range[1] === undefined) return s.received >= s.total ? complete() : send(308, undefined, s.received ? { Range: `bytes=0-${s.received - 1}` } : {});
      if (Number(range[1]) !== s.received) return send(400, { error: 'unexpected offset ' + range[1] + ' (have ' + s.received + ')' });
      const fail = state.failChunks.find(f => f.times > 0);
      if (fail) { fail.times--; if (fail.keep) { const kept = body.subarray(0, fail.keep); s.chunks.push(kept); s.received += kept.length; } return send(fail.status || 503, { error: { code: 503 } }); }
      s.chunks.push(body); s.received += body.length;
      if (s.received >= s.total) return complete();
      return send(308, undefined, { Range: `bytes=0-${s.received - 1}` });
    }
    send(404, { error: 'unknown ' + url.pathname });
  });
  return {
    state, files, sessions, log, server,
    approve() { state.approved = true; },
    async listen(port = 0) { await new Promise(r => server.listen(port, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; return base; },
    endpoints: () => ({ device: base + '/device/code', token: base + '/token', revoke: base + '/revoke', api: base + '/drive/v3', upload: base + '/upload/drive/v3' }),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); })
  };
}
module.exports = { createFakeGoogle };
