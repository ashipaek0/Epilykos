'use strict';
/**
 * Destination: a WebDAV server (Nextcloud, ownCloud, Synology, a Hetzner
 * Storage Box and others). Same calls as the folder destination.
 *
 * One backup is stored as small parts plus a manifest, so servers that cap the
 * size of a request (a reverse proxy, a hosting plan) still take a 117 MB copy:
 *
 *   epilykos-backup-<time>-<id>.epkb          the manifest: JSON, written last
 *   epilykos-backup-<time>-<id>.epkb.p0001    part 1, p0002 ...
 *
 * The manifest appearing is what makes a copy exist, so a copy that was cut
 * short is never listed and its parts are cleaned up next time. A part is held
 * in memory while it is sent (32 MiB), so a failed part is simply sent again.
 * WebDAV has no standard checksum, so a copy is verified by the size of every
 * part as the server reports it, and the whole file is checked end to end by
 * the locked file format itself when it is checked or restored.
 *
 * Redirects are not followed (they would drop the sign-in or change the verb),
 * and certificates are always checked. A server with a certificate of its own
 * (self-signed, or from a private authority) is trusted by pasting that
 * certificate: it becomes the only trusted authority for this server, so the
 * chain is still verified and no other certificate is accepted. Validation is
 * never switched off.
 */
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const NAME = /^epilykos-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[0-9a-f]{6}\.epkb$/;
const PART = /^(epilykos-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[0-9a-f]{6}\.epkb)\.p(\d{4})$/;
const PART_BYTES = 32 * 1024 * 1024;
const ATTEMPTS = 3;
const TIMEOUT_MS = 120000;

function problem(message, code) { return Object.assign(new Error(message), { code, cloudBackup: true }); }
function checkName(name) { if (!NAME.test(String(name))) throw problem('That is not one of our backup file names.', 'BAD_NAME'); return name; }
const partName = (name, index) => `${name}.p${String(index).padStart(4, '0')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Checks what was typed and returns the parts we use. Throws a message the person can act on. */
function parseSettings(settings) {
  const s = settings || {};
  let url;
  try { url = new URL(String(s.url || '').trim()); } catch (_) { throw problem('Enter the server address, starting with https:// (or http:// on your own network).', 'URL_INVALID'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw problem('The server address must start with https:// or http://.', 'URL_INVALID');
  if (url.username || url.password) throw problem('Put the username and password in their own boxes, not in the address.', 'URL_CREDENTIALS');
  if (url.search || url.hash) throw problem('The server address should not contain ? or #.', 'URL_INVALID');
  const folder = String(s.folder == null ? '' : s.folder).trim().replace(/^\/+|\/+$/g, '');
  if (folder.length > 200 || folder.split('/').some(part => part === '.' || part === '..')) throw problem('That folder name is not valid.', 'FOLDER_INVALID');
  const certificate = String(s.certificate || '').trim();
  let pinned = null;
  if (certificate) {
    if (url.protocol !== 'https:') throw problem('A certificate only applies to an https:// address.', 'CERT_INVALID');
    if (certificate.length > 20000) throw problem('That certificate is too long.', 'CERT_INVALID');
    try { pinned = new crypto.X509Certificate(certificate); }
    catch (_) { throw problem('That is not a certificate. Paste the whole certificate, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----.', 'CERT_INVALID'); }
  }
  const username = String(s.username || '');
  if (!username) throw problem('Enter the username.', 'USER_REQUIRED');
  if (!s.password) throw problem('Enter the password. For Nextcloud, make an app password for this box.', 'PASSWORD_REQUIRED');
  return { base: url, folder, certificate, pinned, username, password: String(s.password) };
}

function createWebdavDestination(settings, { requestTimeout = TIMEOUT_MS, partBytes = PART_BYTES, retryDelay = attempt => attempt * 1500 } = {}) {
  const cfg = parseSettings(settings);
  const lib = cfg.base.protocol === 'https:' ? https : http;
  const auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`, 'utf8').toString('base64');
  // A pasted certificate is the only authority trusted for this server. The chain is still verified against it; a server that
  // uses that very certificate is accepted whatever name it is reached by, anything else must pass the normal name check.
  const trust = cfg.pinned ? {
    ca: cfg.certificate,
    checkServerIdentity: (host, cert) => (cert && cert.raw && cfg.pinned.raw.equals(cert.raw) ? undefined : tls.checkServerIdentity(host, cert))
  } : {};
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 2, ...trust });

  const baseParts = cfg.base.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const folderParts = cfg.folder ? cfg.folder.split('/') : [];
  const urlFor = (segments) => {
    const u = new URL(cfg.base.href);
    u.pathname = '/' + [...baseParts, ...segments].map(encodeURIComponent).join('/');
    return u;
  };
  const folderUrl = () => { const u = urlFor(folderParts); if (!u.pathname.endsWith('/')) u.pathname += '/'; return u; };
  const fileUrl = name => urlFor([...folderParts, name]);

  /** One request. Resolves with { status, headers, body } where body is a Buffer, or { status, headers, stream } when `stream` is set. */
  function send(method, url, { headers = {}, body, stream = false, timeout = requestTimeout } = {}) {
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, agent, headers: { Authorization: auth, 'User-Agent': 'Epilykos', ...headers }, timeout }, res => {
        if (stream && res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, headers: res.headers, stream: res });
        const chunks = [];
        res.on('data', c => chunks.push(c)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('The server took too long to answer.'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      if (body) { req.setHeader('Content-Length', body.length); req.end(body); } else req.end();
    }).catch(error => { throw translate(error); });
  }
  function translate(error) {
    if (error.cloudBackup) return error;
    if (cfg.pinned && ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code)) {
      return problem('The server\'s certificate is not the one you pasted (' + error.code + '). Paste the certificate the server is using now.', 'CERT_MISMATCH');
    }
    if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code)) {
      return problem('The server\'s certificate is not trusted (' + error.code + '). If it is a certificate you made yourself, paste it in the certificate box.', 'CERT_UNTRUSTED');
    }
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return problem('Cannot find that server. Check the address.', 'UNREACHABLE');
    if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') return problem('Cannot reach that server (' + error.code + ').', 'UNREACHABLE');
    return error;
  }
  function failed(what, res) {
    const s = res.status;
    if (s === 401) return problem('The server did not accept the username and password.', 'AUTH');
    if (s === 403) return problem('The server refused ' + what + '. Check that this user may write there.', 'FORBIDDEN');
    if (s === 404) return problem('The server says the address does not exist (' + what + '). Check the server address.', 'NOT_FOUND');
    if (s === 507) return problem('The server is out of space.', 'FULL');
    if (s >= 300 && s < 400) return problem('The server redirected to ' + (res.headers.location || 'another address') + '. Use that address instead.', 'REDIRECT');
    return Object.assign(problem(`The server answered ${s} when ${what}.`, 'HTTP_' + s), { status: s });
  }
  const ok = res => res.status >= 200 && res.status < 300;

  async function propfind(url, depth) {
    const res = await send('PROPFIND', url, { headers: { Depth: String(depth), 'Content-Type': 'application/xml' },
      body: Buffer.from('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>') });
    if (res.status === 404) return null;
    if (res.status !== 207 && !ok(res)) throw failed('looking at the folder', res);
    return parseMultistatus(res.body.toString('utf8'), url);
  }
  /** Entries of a PROPFIND answer: [{ name, size, collection }] (the folder itself is left out). */
  function parseMultistatus(xml, url) {
    const own = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    const out = [];
    for (const block of xml.split(/<(?:\w+:)?response[ >]/i).slice(1)) {
      const href = /<(?:\w+:)?href[^>]*>([^<]*)</i.exec(block);
      if (!href) continue;
      let p; try { p = decodeURIComponent(new URL(href[1], url).pathname); } catch (_) { continue; }
      if (p.replace(/\/+$/, '') === own) continue;
      const length = /<(?:\w+:)?getcontentlength[^>]*>(\d+)</i.exec(block);
      out.push({ name: p.replace(/\/+$/, '').split('/').pop(), size: length ? Number(length[1]) : 0, collection: /<(?:\w+:)?collection\b/i.test(block) });
    }
    return out;
  }

  async function ensureFolder() {
    // The server address must exist; only the last folder of ours is created.
    const listing = await propfind(folderUrl(), 0);
    if (listing !== null) return;
    if (!folderParts.length) throw problem('The server says the address does not exist. Check the server address.', 'NOT_FOUND');
    const res = await send('MKCOL', folderUrl());
    if (res.status === 409) throw problem('The parent of that folder does not exist on the server. Create the folder there first, or use an existing one.', 'PARENT_MISSING');
    if (!ok(res) && res.status !== 405) throw failed('creating the folder', res);
  }

  async function putBuffer(url, buffer) {
    let last;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const res = await send('PUT', url, { body: buffer, headers: { 'Content-Type': 'application/octet-stream' } });
        if (ok(res)) return;
        last = failed('sending a file', res);
        if (res.status < 500 && res.status !== 408 && res.status !== 429) throw last;   // retrying will not help
      } catch (error) {
        if (error.cloudBackup && error.code !== 'ETIMEDOUT' && !/^HTTP_5/.test(error.code || '')) throw error;
        last = error;
      }
      if (attempt < ATTEMPTS) await sleep(retryDelay(attempt));
    }
    throw last;
  }
  async function deleteFile(name) {
    const res = await send('DELETE', fileUrl(name));
    if (!ok(res) && res.status !== 404) throw failed('removing a file', res);
  }

  return {
    type: 'webdav',
    describe: () => `${cfg.base.host}${cfg.folder ? '/' + cfg.folder : ''}`,
    async test() {
      const warnings = [];
      if (cfg.base.protocol === 'http:') warnings.push('This address is not encrypted, so the password is sent in the clear. Your backups are still locked, but use https:// unless this is your own network.');
      await ensureFolder();
      const probe = `.epilykos-write-test-${crypto.randomBytes(4).toString('hex')}`;
      await putBuffer(fileUrl(probe), Buffer.from('ok'));
      await deleteFile(probe);
      return { ok: true, warnings };
    },
    async put(name, readable, { size } = {}) {
      checkName(name);
      await ensureFolder();
      const hash = crypto.createHash('sha256');
      let total = 0, index = 0, held = [], heldBytes = 0;
      const sendPart = async () => {
        index++;
        await putBuffer(fileUrl(partName(name, index)), Buffer.concat(held, heldBytes));
        held = []; heldBytes = 0;
      };
      for await (const chunk of readable) {
        hash.update(chunk); total += chunk.length;
        let data = chunk;
        while (heldBytes + data.length >= partBytes) {
          const take = partBytes - heldBytes;
          held.push(data.subarray(0, take)); heldBytes += take; data = data.subarray(take);
          await sendPart();
        }
        if (data.length) { held.push(data); heldBytes += data.length; }
      }
      if (heldBytes || index === 0) await sendPart();
      if (size !== undefined && size !== total) throw problem('The file changed while it was being sent. Try again.', 'CHANGED');
      const sha256 = hash.digest('hex');
      const manifest = { v: 1, parts: index, partBytes, bytes: total, sha256 };
      await putBuffer(fileUrl(name), Buffer.from(JSON.stringify(manifest)));   // the copy exists once this is there
      return { bytes: total, sha256 };
    },
    async verify(name, expected) {
      checkName(name);
      const listing = await propfind(folderUrl(), 1);
      const files = new Map((listing || []).map(e => [e.name, e.size]));
      const manifest = await readManifest(name);
      if (manifest.bytes !== expected.bytes || manifest.sha256 !== expected.sha256) throw problem('The server holds a different copy from the one that was sent.', 'VERIFY_FAILED');
      let sum = 0;
      for (let i = 1; i <= manifest.parts; i++) {
        const want = Math.min(manifest.partBytes, manifest.bytes - (i - 1) * manifest.partBytes);
        const have = files.get(partName(name, i));
        if (have !== want) throw problem(`The server holds part ${i} of the copy with the wrong size (${have === undefined ? 'missing' : have} instead of ${want}).`, 'VERIFY_FAILED');
        sum += have;
      }
      if (sum !== manifest.bytes) throw problem('The copy on the server is the wrong size.', 'VERIFY_FAILED');
    },
    async list() {
      const listing = await propfind(folderUrl(), 1);
      if (!listing) return [];
      const out = [];
      for (const entry of listing) {
        if (entry.collection || !NAME.test(entry.name)) continue;
        try { out.push({ name: entry.name, size: (await readManifest(entry.name)).bytes }); } catch (_) { /* a damaged manifest is not a copy */ }
      }
      return out;
    },
    get(name) {
      checkName(name);
      return Readable.from((async function* () {
        const manifest = await readManifest(name);
        for (let i = 1; i <= manifest.parts; i++) {
          let attempt = 0, res;
          for (;;) {
            attempt++;
            try { res = await send('GET', fileUrl(partName(name, i)), { stream: true, timeout: requestTimeout }); if (res.stream) break; throw failed('downloading a part', res); }
            catch (error) { if (attempt >= ATTEMPTS || (error.cloudBackup && !/^HTTP_5/.test(error.code || ''))) throw error; await sleep(retryDelay(attempt)); }
          }
          yield* res.stream;
        }
      })());
    },
    async remove(name) {
      checkName(name);
      await deleteFile(name);                                 // the copy stops existing first
      const listing = await propfind(folderUrl(), 1);
      for (const entry of listing || []) { const m = PART.exec(entry.name); if (m && m[1] === name) await deleteFile(entry.name); }
    },
    async cleanPartial() {
      const listing = await propfind(folderUrl(), 1);
      if (!listing) return;
      const manifests = new Set(listing.map(e => e.name).filter(n => NAME.test(n)));
      for (const entry of listing) { const m = PART.exec(entry.name); if (m && !manifests.has(m[1])) await deleteFile(entry.name); }
    }
  };

  async function readManifest(name) {
    const res = await send('GET', fileUrl(name));
    if (!ok(res)) throw failed('reading a copy', res);
    let manifest; try { manifest = JSON.parse(res.body.toString('utf8')); } catch (_) { throw problem('A backup record on the server is damaged.', 'DAMAGED'); }
    if (manifest.v !== 1 || !Number.isInteger(manifest.parts) || manifest.parts < 1 || !Number.isInteger(manifest.bytes) || !Number.isInteger(manifest.partBytes) || manifest.partBytes < 1 || !/^[0-9a-f]{64}$/.test(manifest.sha256 || '')) {
      throw problem('A backup record on the server is damaged.', 'DAMAGED');
    }
    return manifest;
  }
}

module.exports = { createWebdavDestination, parseSettings, NAME };
