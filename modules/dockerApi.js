'use strict';
/**
 * Minimal Docker Engine API client over the mounted socket, for one job only:
 * updating this container (Settings → Updates, see modules/dockerUpdate.js and
 * scripts/self-update.js). No other part of the app talks to Docker.
 */
const fs = require('fs');
const http = require('http');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function available(socket = SOCKET) {
  try { return fs.statSync(socket).isSocket(); } catch (_) { return false; }
}

/**
 * One request. Resolves { status, body } (JSON parsed when it is JSON; for a
 * streamed reply like an image pull, the array of JSON lines; a Buffer with raw).
 */
function request(method, path, { body, socket = SOCKET, timeoutMs = 60000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath: socket, method, path,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': payload.length } : {}) },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (raw) return resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) {
          const lines = text.split('\n').filter(Boolean);
          try { parsed = lines.map(l => JSON.parse(l)); } catch (_) { /* plain text */ }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker did not answer ${method} ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** request() that rejects on an error status, with Docker's message. */
async function call(method, path, opts) {
  const res = await request(method, path, opts);
  if (res.status >= 400) {
    const msg = res.body && (res.body.message || (typeof res.body === 'string' ? res.body : '')) || `HTTP ${res.status}`;
    const err = new Error(`Docker: ${String(msg).trim()}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

/**
 * This container's id, from /proc/self/mountinfo (Docker bind-mounts
 * /etc/hostname from /var/lib/docker/containers/<id>/), so it works even
 * when the compose file sets a hostname.
 */
function selfId(mountinfo) {
  let text = mountinfo;
  if (text === undefined) { try { text = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch (_) { text = ''; } }
  const m = /\/containers\/([0-9a-f]{64})\//.exec(text);
  return m ? m[1] : null;
}

/**
 * Text of a container's log reply. Without a TTY Docker frames each chunk
 * with an 8-byte header (stream, 0, 0, 0, size as uint32 BE).
 */
function demuxLogs(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  let out = '', i = 0;
  while (i + 8 <= buf.length && buf[i] <= 2 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.slice(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return i === 0 ? buf.toString('utf8') : out;
}

module.exports = { available, request, call, selfId, demuxLogs, SOCKET };
