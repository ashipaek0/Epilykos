'use strict';
/**
 * Destination: a folder on this box (a USB drive, a mounted network share, a
 * Docker volume).
 *
 * Every destination offers the same small set of calls, so Google Drive and
 * WebDAV can slot in later:
 *
 *   describe()              short text for the status line
 *   test()                  can we write here? → { ok, warnings[] }
 *   put(name, readable)     store a stream; → { bytes, sha256 }
 *   verify(name, expected)  read it back; throws when it does not match
 *   list()                  → [{ name, size }] of our backup files
 *   get(name)               → readable stream
 *   remove(name)
 *   cleanPartial()          remove unfinished uploads from earlier runs
 *
 * A mount that is missing must never make us fill the SD card, so only the
 * last folder of the path is created, and only when its parent exists.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const NAME = /^epilykos-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[0-9a-f]{6}\.epkb$/;
const PART = /^epilykos-backup-.*\.epkb\.part$/;

function problem(message, code) { return Object.assign(new Error(message), { code, cloudBackup: true }); }
function checkName(name) { if (!NAME.test(String(name))) throw problem('That is not one of our backup file names.', 'BAD_NAME'); return name; }

function folderPath(settings) {
  const value = settings && settings.path;
  if (typeof value !== 'string' || !value.trim()) throw problem('Enter the folder to back up to.', 'PATH_REQUIRED');
  if (value.includes('\0') || value.length > 1024) throw problem('That folder path is not valid.', 'PATH_INVALID');
  if (!path.isAbsolute(value)) throw problem('Enter a full folder path, starting with /.', 'PATH_RELATIVE');
  return path.resolve(value);
}

function createFolderDestination(settings, { dataDir } = {}) {
  const dir = folderPath(settings);

  function ensureDir() {
    let info = null;
    try { info = fs.statSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw problem('Cannot use that folder: ' + error.message, 'PATH_UNUSABLE'); }
    if (info && !info.isDirectory()) throw problem('That path is a file, not a folder.', 'PATH_NOT_DIR');
    if (!info) {
      const parent = path.dirname(dir);
      let parentInfo = null;
      try { parentInfo = fs.statSync(parent); } catch (_) {}
      if (!parentInfo || !parentInfo.isDirectory()) throw problem('The folder\'s parent does not exist. Is the drive or share mounted?', 'PARENT_MISSING');
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { throw problem('Cannot create the folder: ' + error.message, 'PATH_UNUSABLE'); }
    }
  }

  return {
    type: 'folder',
    describe: () => dir,
    async test() {
      ensureDir();
      const probe = path.join(dir, `.epilykos-write-test-${crypto.randomBytes(4).toString('hex')}`);
      try { fs.writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 }); fs.unlinkSync(probe); }
      catch (error) { throw problem('Cannot write to that folder: ' + error.message, 'NOT_WRITABLE'); }
      const warnings = [];
      try {
        if (dataDir && fs.statSync(dir).dev === fs.statSync(dataDir).dev) {
          warnings.push('This folder is on the same disk as Epilykos\'s data, so it will not survive that disk failing. Use a USB drive or a network share.');
        }
      } catch (_) { /* best effort */ }
      return { ok: true, warnings };
    },
    async put(name, readable) {
      checkName(name); ensureDir();
      const part = path.join(dir, name + '.part');
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const meter = new Transform({ transform(chunk, _, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); } });
      try {
        await pipeline(readable, meter, fs.createWriteStream(part, { flags: 'w', mode: 0o600 }));
        const fd = fs.openSync(part, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(part, path.join(dir, name));
      } catch (error) {
        try { fs.unlinkSync(part); } catch (_) {}
        throw error;
      }
      return { bytes, sha256: hash.digest('hex') };
    },
    async verify(name, expected) {
      checkName(name);
      const file = path.join(dir, name);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      await pipeline(fs.createReadStream(file), new Transform({ transform(chunk, _, done) { bytes += chunk.length; hash.update(chunk); done(); } }));
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw problem('The copy written to the folder does not match what was sent.', 'VERIFY_FAILED');
    },
    async list() {
      let names;
      try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw problem('Cannot read the backup folder: ' + error.message, 'PATH_UNUSABLE'); }
      const out = [];
      for (const name of names) {
        if (!NAME.test(name)) continue;
        try { const info = fs.statSync(path.join(dir, name)); if (info.isFile()) out.push({ name, size: info.size }); } catch (_) {}
      }
      return out;
    },
    get(name) { checkName(name); return fs.createReadStream(path.join(dir, name)); },
    async remove(name) { checkName(name); try { fs.unlinkSync(path.join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    async cleanPartial() {
      let names; try { names = fs.readdirSync(dir); } catch (_) { return; }
      for (const name of names) if (PART.test(name)) { try { fs.unlinkSync(path.join(dir, name)); } catch (_) {} }
    }
  };
}

module.exports = { createFolderDestination, NAME, folderPath };
