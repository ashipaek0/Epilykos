'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const { normalizeRestoreInput } = require('../modules/restoreInput');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-input-'));
const db = new Database(path.join(root, 'live.db')); db.exec('CREATE TABLE live(value)');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
async function compressed(name = 'source', size = 0) {
  const file = path.join(root, name + '.db'), sql = new Database(file);
  sql.exec('CREATE TABLE sample(value)'); if (size) sql.prepare('INSERT INTO sample VALUES(zeroblob(?))').run(size); sql.close();
  const gz = path.join(root, name + '.bin'); await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(gz)); return { file, gz };
}
function jobs() { return fs.readdirSync(root).filter(n => /^\.restore-expand-[A-Za-z0-9]{6}$/.test(n)); }
test('raw passthrough and small magic-detected gzip restore stream byte-identical SQLite', async () => {
  const { file, gz } = await compressed(); assert.ok(fs.statSync(gz).size < 512);
  const raw = await normalizeRestoreInput(file, db, path.join(root, 'live.db')); assert.equal(raw.filePath, file); raw.cleanup();
  const expanded = await normalizeRestoreInput(gz, db, path.join(root, 'live.db'));
  try { assert.deepEqual(fs.readFileSync(expanded.filePath), fs.readFileSync(file)); assert.equal(fs.statSync(path.dirname(expanded.filePath)).mode & 0o777, 0o700); }
  finally { expanded.cleanup(); } assert.deepEqual(jobs(), []);
});
test('truncated, bad CRC and invalid archive fail without leaking staging', async () => {
  const { gz } = await compressed('corrupt'), bytes = fs.readFileSync(gz);
  for (const bad of [bytes.subarray(0, bytes.length - 3), Buffer.from(bytes)]) {
    if (bad.length === bytes.length) bad[bad.length - 8] ^= 1;
    const file = path.join(root, 'bad.gz'); fs.writeFileSync(file, bad);
    await assert.rejects(normalizeRestoreInput(file, db, path.join(root, 'live.db')), /gzip|archive|check|unexpected/i); assert.deepEqual(jobs(), []);
  }
});
test('expanded output cannot exceed actual admitted DATA even with tiny compressed input', async () => {
  const { gz } = await compressed('bomb', 2 * 1024 * 1024), original = fs.statfsSync;
  fs.statfsSync = () => ({ bsize: 1, blocks: 1024 ** 3, bavail: 32 * 1024 * 1024 + 8192 + 3 * 1024 * 1024 });
  try { await assert.rejects(normalizeRestoreInput(gz, db, path.join(root, 'live.db')), e => e.status === 507); assert.deepEqual(jobs(), []); }
  finally { fs.statfsSync = original; }
});
test('gzip source aliases and sidecars are refused before expansion', async () => {
  const { gz } = await compressed('aliases'); fs.writeFileSync(gz + '-wal', 'unknown');
  await assert.rejects(normalizeRestoreInput(gz, db, path.join(root, 'live.db')), /sidecar/); fs.unlinkSync(gz + '-wal');
  await assert.rejects(normalizeRestoreInput(gz, db, gz), /separate/); assert.deepEqual(jobs(), []);
});
test('pre-cancelled expansion allocates no job', async () => {
  const { gz } = await compressed('cancel'); await assert.rejects(normalizeRestoreInput(gz, db, path.join(root, 'live.db'), { signal: AbortSignal.abort(new Error('stop expansion')) }), /stop expansion/); assert.deepEqual(jobs(), []);
});
test('abort during expansion closes streams before owned DATA cleanup', async () => {
  const { gz } = await compressed('mid-cancel', 16 * 1024 * 1024), controller = new AbortController(); let interrupted = false;
  const timer = setInterval(() => {
    const name = jobs()[0]; if (!name) return;
    try { if (fs.statSync(path.join(root, name, 'expanded.db')).size > 0) { interrupted = true; controller.abort(new Error('stop expanding')); } } catch (_) {}
  }, 1);
  try { await assert.rejects(normalizeRestoreInput(gz, db, path.join(root, 'live.db'), { signal: controller.signal }), /abort|stop/i); assert.equal(interrupted, true); assert.deepEqual(jobs(), []); }
  finally { clearInterval(timer); }
});
test('gzip source changing during the stream cannot become a prepared input', async () => {
  const { gz } = await compressed('changed', 4 * 1024 * 1024), original = fs.createReadStream;
  fs.createReadStream = function (file, ...args) {
    const stream = original.call(this, file, ...args);
    if (file === gz) stream.once('close', () => fs.utimesSync(gz, new Date(), new Date(Date.now() + 2000)));
    return stream;
  };
  try { await assert.rejects(normalizeRestoreInput(gz, db, path.join(root, 'live.db')), /changed during expansion/); assert.deepEqual(jobs(), []); }
  finally { fs.createReadStream = original; }
});
test('unknown contents survive expansion failure and conservative orphan reaping', async () => {
  const { gz } = await compressed('unknown'), bytes = fs.readFileSync(gz); bytes[bytes.length - 8] ^= 1; fs.writeFileSync(gz, bytes);
  const original = fs.createWriteStream;
  fs.createWriteStream = function (file, ...args) { fs.writeFileSync(path.join(path.dirname(file), 'unrelated.db'), 'preserve'); return original.call(this, file, ...args); };
  try { await assert.rejects(normalizeRestoreInput(gz, db, path.join(root, 'live.db')), /gzip/i); }
  finally { fs.createWriteStream = original; }
  const names = jobs(); assert.equal(names.length, 1);
  assert.deepEqual(await require('../modules/restoreStaging').reapRestoreStaging(root), []);
  assert.equal(fs.readFileSync(path.join(root, names[0], 'unrelated.db'), 'utf8'), 'preserve');
});
