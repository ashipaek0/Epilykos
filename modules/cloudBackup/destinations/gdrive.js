'use strict';
/**
 * Destination: Google Drive, in a folder called Epilykos that you can see and delete yourself.
 *
 * Only the drive.file permission is used, so Epilykos sees only files it created itself. Same calls as the
 * other destinations, plus `own`: a list entry says whether this box made it, so a second box using the same
 * Drive never deletes another box's copy. A backup is one file, sent with Google's resumable upload in
 * chunks (8 MiB, held in memory, so a failed chunk is simply sent again, or continued from where Google
 * says it got to). After sending, Google's own MD5 for the file is compared with ours.
 */
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const NAME = /^epilykos-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[0-9a-f]{6}\.epkb$/;
const FOLDER_NAME = 'Epilykos';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GRANULE = 256 * 1024;
const CHUNK_BYTES = 32 * GRANULE;            // 8 MiB
const ATTEMPTS = 4;

function problem(message, code) { return Object.assign(new Error(message), { code, cloudBackup: true }); }
function checkName(name) { if (!NAME.test(String(name))) throw problem('That is not one of our backup file names.', 'BAD_NAME'); return name; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A connection that broke while an answer was being read (Node reports it as "terminated"): worth another try. */
function lost(error, what) {
  const why = (error && error.cause && (error.cause.code || error.cause.message)) || (error && error.message) || 'unknown';
  return Object.assign(new Error(`Lost the connection to Google Drive while ${what} (${why}).`), { transient: true });
}
/** Reads an answer's JSON; a cut connection or a half answer counts as a connection problem, not a final failure. */
async function readJson(res, what) { try { return await res.json(); } catch (error) { throw lost(error, what); } }
/** Drops an answer's body without waiting for it (a 308 has nothing in it). */
function discard(res) { try { const done = res.body && res.body.cancel(); if (done && done.catch) done.catch(() => {}); } catch (_) { /* already closed */ } }
const quote = text => "'" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

/**
 * @param auth    createGoogleAuth(...)
 * @param tokens  { get(): { refresh_token, folder_id, box }, save(patch) }
 */
function createGdriveDestination({ auth, tokens, fetchImpl = fetch, chunkBytes = CHUNK_BYTES, retryDelay = attempt => attempt * 2000, requestTimeout = 60000 } = {}) {
  if (chunkBytes % GRANULE !== 0) throw new Error('chunkBytes must be a multiple of 256 KiB');
  const { api, upload } = auth.endpoints;
  let access = null;

  async function accessToken(force) {
    if (!force && access && access.expiresAt - 60000 > Date.now()) return access.accessToken;
    const refresh = tokens.get().refresh_token;
    if (!refresh) throw problem('Google Drive is not connected. Connect it first.', 'GOOGLE_NOT_CONNECTED');
    access = await auth.refresh(refresh);
    return access.accessToken;
  }

  /** One authorised request. Renews the access token once if Google says it ran out. */
  async function request(method, target, { headers = {}, body, timeout = requestTimeout } = {}) {
    for (let round = 0; round < 2; round++) {
      let res;
      try {
        res = await fetchImpl(target, { method, headers: { Authorization: 'Bearer ' + await accessToken(round === 1), ...headers }, body, signal: AbortSignal.timeout(timeout) });
      } catch (error) {
        if (error.cloudBackup) throw error;
        throw Object.assign(new Error('Cannot reach Google Drive: ' + (error.cause && error.cause.code || error.message)), { transient: true });
      }
      if (res.status === 401 && round === 0) { try { await res.arrayBuffer(); } catch (_) {} continue; }
      return res;
    }
  }
  async function failure(what, res) {
    let reason = '', message = '';
    try { const j = await res.json(); reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || ''; message = (j.error && j.error.message) || ''; } catch (_) { /* not JSON */ }
    if (res.status === 401) return problem('Google Drive access was removed or has expired. Connect it again.', 'GOOGLE_REVOKED');
    if (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded') return problem('Google Drive is full.', 'FULL');
    if (res.status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')) return Object.assign(new Error('Google asked Epilykos to slow down.'), { transient: true });
    if (res.status === 403) return problem(`Google Drive refused ${what}${message ? ': ' + message : ''}.`, 'FORBIDDEN');
    if (res.status === 404) return problem(`Google Drive could not find what Epilykos asked for while ${what}.`, 'NOT_FOUND');
    const error = Object.assign(new Error(`Google Drive answered ${res.status} when ${what}${message ? ': ' + message : ''}.`), { status: res.status });
    if (res.status >= 500 || res.status === 408 || res.status === 429) error.transient = true; else error.cloudBackup = true;
    return error;
  }
  /** Runs `attempt` again for problems that may pass (the network, Google being busy); anything else is thrown at once. */
  async function retrying(attempt) {
    let last;
    for (let n = 1; n <= ATTEMPTS; n++) {
      try { return await attempt(n); } catch (error) { if (!error.transient) throw error; last = error; if (n < ATTEMPTS) await sleep(retryDelay(n)); }
    }
    last.cloudBackup = true; throw last;
  }
  const json = async (what, res) => { if (!res.ok) throw await failure(what, res); return readJson(res, what); };

  const boxId = () => {
    let { box } = tokens.get();
    if (!box) { box = crypto.randomBytes(8).toString('hex'); tokens.save({ box }); }
    return box;
  };

  async function ensureFolder() {
    const saved = tokens.get().folder_id;
    if (saved) {
      const res = await request('GET', `${api}/files/${encodeURIComponent(saved)}?fields=id,trashed`);
      if (res.ok) { const f = await readJson(res, 'looking for the Epilykos folder'); if (!f.trashed) return saved; } else if (res.status !== 404) throw await failure('looking for the Epilykos folder', res); else discard(res);
    }
    const q = `name = ${quote(FOLDER_NAME)} and mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`;
    const found = await retrying(async () => json('looking for the Epilykos folder', await request('GET', `${api}/files?q=${encodeURIComponent(q)}&orderBy=createdTime&fields=files(id)&pageSize=10&spaces=drive`)));
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const made = await retrying(async () => json('creating the Epilykos folder', await request('POST', `${api}/files?fields=id`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }) })));
      id = made.id;
    }
    tokens.save({ folder_id: id });
    return id;
  }

  /** Starts a resumable upload and sends `total` bytes, a chunk at a time from `nextBytes()`; returns the file record. */
  async function resumable(metadata, total, nextBytes) {
    const start = await retrying(async () => {
      const res = await request('POST', `${upload}/files?uploadType=resumable&fields=id,size,md5Checksum`, {
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(total) }, body: JSON.stringify(metadata) });
      if (!res.ok) throw await failure('starting the upload', res);
      const location = res.headers.get('location');
      if (!location) throw problem('Google Drive did not start an upload.', 'NO_SESSION');
      return location;
    });
    let offset = 0, record = null;
    while (offset < total) {
      const chunk = await nextBytes();                 // the next chunk of the file, in memory
      if (!chunk.length) throw problem('The file ended before its promised size.', 'CHANGED');
      record = (await sendChunk(start, offset, chunk, total)) || record;
      offset += chunk.length;
    }
    if (!record) {
      const done = await fetchImpl(start, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' }, signal: AbortSignal.timeout(requestTimeout) });
      if (!done.ok) throw await failure('finishing the upload', done);
      record = await readJson(done, 'finishing the upload');
    }
    return record;
  }

  /** Sends one chunk. After a failure, asks Google how far it got and carries on from there. Returns the file record after the last chunk. */
  async function sendChunk(session, offset, chunk, total) {
    let from = 0, last;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          const probe = await fetchImpl(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' }, signal: AbortSignal.timeout(requestTimeout) })
            .catch(error => { throw Object.assign(new Error(error.message), { transient: true }); });
          if (probe.status === 200 || probe.status === 201) return readJson(probe, 'checking the upload');
          if (probe.status !== 308) throw await failure('continuing the upload', probe);
          discard(probe);
          const range = /bytes=0-(\d+)/.exec(probe.headers.get('range') || '');
          from = Math.min(chunk.length, Math.max(0, (range ? Number(range[1]) + 1 : 0) - offset));
          if (from >= chunk.length) return null;   // Google already has all of it
        }
        let res;
        try {
          res = await fetchImpl(session, { method: 'PUT', body: chunk.subarray(from), signal: AbortSignal.timeout(requestTimeout * 3),
            headers: { 'Content-Range': `bytes ${offset + from}-${offset + chunk.length - 1}/${total}`, 'Content-Length': String(chunk.length - from) } });
        } catch (error) { throw Object.assign(new Error('Cannot reach Google Drive: ' + (error.cause && error.cause.code || error.message)), { transient: true }); }
        if (res.status === 308) { discard(res); return null; }
        if (res.ok) return await readJson(res, 'sending the file');
        throw await failure('sending the file', res);
      } catch (error) {
        if (!error.transient) throw error;
        last = error;
        if (attempt < ATTEMPTS) await sleep(retryDelay(attempt));
      }
    }
    last.cloudBackup = true; throw last;
  }

  async function filesNamed(name, folder) {
    const q = `'${folder}' in parents and trashed = false and name = ${quote(name)}`;
    const out = await retrying(async () => json('looking for a copy', await request('GET', `${api}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,md5Checksum,appProperties)&pageSize=20&orderBy=createdTime desc`)));
    return out.files || [];
  }

  return {
    type: 'gdrive',
    describe: () => 'Google Drive › ' + FOLDER_NAME,
    async test() {
      const folder = await ensureFolder();
      const probe = Buffer.from('ok');
      const record = await resumable({ name: `.epilykos-write-test-${crypto.randomBytes(4).toString('hex')}`, parents: [folder], appProperties: { box: boxId() } }, probe.length, async () => probe);
      await retrying(async () => { const res = await request('DELETE', `${api}/files/${encodeURIComponent(record.id)}`); if (!res.ok && res.status !== 404) throw await failure('removing the test file', res); });
      return { ok: true, warnings: [] };
    },
    async put(name, readable, { size } = {}) {
      checkName(name);
      if (!Number.isSafeInteger(size) || size < 1) throw problem('The size of the copy is needed to send it to Google Drive.', 'SIZE_REQUIRED');
      const folder = await ensureFolder();
      const sha = crypto.createHash('sha256'), md5 = crypto.createHash('md5');
      const iterator = readable[Symbol.asyncIterator]();
      let held = [], heldBytes = 0, ended = false, total = 0;
      const nextBytes = async () => {
        while (!ended && heldBytes < chunkBytes) {
          const { value, done } = await iterator.next();
          if (done) { ended = true; break; }
          sha.update(value); md5.update(value); total += value.length; held.push(value); heldBytes += value.length;
        }
        const all = Buffer.concat(held, heldBytes);
        const take = Math.min(chunkBytes, all.length);
        held = take < all.length ? [all.subarray(take)] : []; heldBytes = all.length - take;
        return all.subarray(0, take);
      };
      const record = await resumable({ name, parents: [folder], appProperties: { box: boxId() } }, size, nextBytes);
      // The source must have ended exactly at the size we promised. If not, what reached Google is not the whole copy: remove it.
      let extra = false;
      if (!ended) { const rest = await iterator.next(); extra = !rest.done; }
      if (extra || total !== size) {
        try { await request('DELETE', `${api}/files/${encodeURIComponent(record.id)}`); } catch (_) { /* best effort */ }
        throw problem('The file changed while it was being sent. Try again.', 'CHANGED');
      }
      const sent = { bytes: total, sha256: sha.digest('hex'), md5: md5.digest('hex'), id: record.id };
      return sent;
    },
    async verify(name, expected) {
      checkName(name);
      const folder = await ensureFolder();
      const mine = (await filesNamed(name, folder)).find(f => (!expected.id || f.id === expected.id));
      if (!mine) throw problem('Google Drive does not show the copy that was just sent.', 'VERIFY_FAILED');
      if (Number(mine.size) !== expected.bytes) throw problem('The copy on Google Drive is the wrong size.', 'VERIFY_FAILED');
      if (mine.md5Checksum && expected.md5 && mine.md5Checksum !== expected.md5) throw problem('Google Drive holds a different copy from the one that was sent.', 'VERIFY_FAILED');
    },
    async list() {
      const folder = await ensureFolder();
      const box = boxId();
      const out = [];
      let pageToken = '';
      do {
        const q = `'${folder}' in parents and trashed = false and name contains 'epilykos-backup-'`;
        const page = await retrying(async () => json('listing the copies', await request('GET', `${api}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,size,appProperties)&pageSize=100${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`)));
        for (const f of page.files || []) if (NAME.test(f.name)) out.push({ name: f.name, size: Number(f.size) || 0, own: Boolean(f.appProperties && f.appProperties.box === box) });
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    get(name) {
      checkName(name);
      return Readable.from((async function* () {
        const folder = await ensureFolder();
        const file = (await filesNamed(name, folder))[0];
        if (!file) throw problem('That copy is no longer on Google Drive.', 'NOT_FOUND');
        const res = await retrying(async () => { const r = await request('GET', `${api}/files/${encodeURIComponent(file.id)}?alt=media`, { timeout: 10 * 60000 }); if (!r.ok) throw await failure('downloading the copy', r); return r; });
        yield* Readable.fromWeb(res.body);
      })());
    },
    async remove(name) {
      checkName(name);
      const folder = await ensureFolder();
      const box = boxId();
      for (const f of await filesNamed(name, folder)) {
        if (f.appProperties && f.appProperties.box && f.appProperties.box !== box) continue;   // another box's copy
        await retrying(async () => { const res = await request('DELETE', `${api}/files/${encodeURIComponent(f.id)}`); if (!res.ok && res.status !== 404) throw await failure('removing a copy', res); });
      }
    },
    async cleanPartial() { /* an upload that never finished leaves nothing in Drive */ }
  };
}

module.exports = { createGdriveDestination, NAME, FOLDER_NAME };
