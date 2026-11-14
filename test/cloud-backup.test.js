'use strict';
const checks = require('./_checks');
// Remote backup (modules/cloudBackup, routes/cloudBackup.js, the Backup and restore card): the locked file format, the folder
// destination, the service (validation, weekly schedule, keep N with replace-after-verify, failures, restore) and the wiring.
// (The card is checked in a browser.)
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const REPO = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const envelope = require(path.join(REPO, 'modules/cloudBackup/envelope'));
const { createFolderDestination } = require(path.join(REPO, 'modules/cloudBackup/destinations/folder'));
const { createCloudBackup, timeOfName } = require(path.join(REPO, 'modules/cloudBackup'));

const PASS = 'correct horse battery';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-cloud-'));
const collect = async stream => { const parts = []; await pipeline(stream, new Writable({ write(c, _, d) { parts.push(c); d(); } })); return Buffer.concat(parts); };
const lock = async (plain, pass = PASS) => collect(Readable.from([plain]).pipe(await envelope.createLocker(pass)));
const unlock = async (locked, pass = PASS) => collect(Readable.from([locked]).pipe(await envelope.createUnlocker(pass)));
const rejects = async (promise, pattern, label) => { let error = null; try { await promise; } catch (e) { error = e; } assert.ok(error, label + ': should fail'); assert.match(error.message, pattern, label); return error; };

(async () => {
  // ── The locked file: round trip at the block edges ──
  for (const n of [0, 1, 65535, 65536, 65537, 200000]) {
    const plain = crypto.randomBytes(n);
    const locked = await lock(plain);
    assert.strictEqual(locked.length, envelope.lockedSize(n), `locked size for ${n} bytes`);
    assert.ok((await unlock(locked)).equals(plain), `round trip of ${n} bytes`);
  }
  // Arriving in odd pieces makes no difference.
  const plain = crypto.randomBytes(150000), locked = await lock(plain);
  const pieces = [locked.subarray(0, 7), locked.subarray(7, 49), locked.subarray(49, 70000), locked.subarray(70000)];
  assert.ok((await collect(Readable.from(pieces).pipe(await envelope.createUnlocker(PASS)))).equals(plain), 'odd chunking');

  // Nothing readable, and every locking is different.
  const marker = Buffer.from('SQLite format 3 secret-history-marker');
  const lockedMarker = await lock(Buffer.concat([marker, crypto.randomBytes(1000)]));
  assert.ok(!lockedMarker.includes(marker), 'the contents are not visible');
  assert.ok(!(await lock(plain)).equals(locked), 'fresh salt and nonce each time');

  // Wrong passphrase, tampering, cut-off and reordering are all caught.
  await rejects(unlock(locked, 'wrong passphrase here'), /does not open/, 'wrong passphrase');
  const flipped = Buffer.from(locked); flipped[envelope.HEADER_BYTES + 100] ^= 1;
  await rejects(unlock(flipped), /damaged or incomplete/, 'a changed byte');
  const headerFlip = Buffer.from(locked); headerFlip[30] ^= 1;
  await rejects(unlock(headerFlip), /does not open|damaged/, 'a changed header');
  await rejects(unlock(locked.subarray(0, locked.length - 1)), /damaged or incomplete/, 'one byte missing');
  const frame = envelope.FRAME_BYTES, big = await lock(crypto.randomBytes(frame * 2 + 500 - 16 * 3));
  await rejects(unlock(big.subarray(0, envelope.HEADER_BYTES + frame)), /damaged or incomplete|ends early/, 'cut after a whole block');
  const swapped = Buffer.concat([big.subarray(0, 48), big.subarray(48 + frame, 48 + 2 * frame), big.subarray(48, 48 + frame), big.subarray(48 + 2 * frame)]);
  await rejects(unlock(swapped), /damaged or incomplete/, 'blocks in a different order');
  await rejects(unlock(Buffer.from('not a backup at all, just some text that is long enough to have a header....')), /not an Epilykos/, 'not a backup');
  await rejects(unlock(Buffer.alloc(0)), /empty or incomplete/, 'empty');

  // Passphrase rules; the same text typed another way is the same passphrase.
  await rejects(lock(plain, 'short'), /at least 8/, 'too short');
  await rejects(lock(plain, 'x'.repeat(257)), /at most 256/, 'too long');
  await rejects(lock(plain, 42), /Enter a passphrase/, 'not text');
  assert.ok((await unlock(await lock(plain, 'Café au lait 2026'), 'Café au lait 2026')).equals(plain), 'NFKC');

  // The quick check of a copy.
  assert.deepStrictEqual(await envelope.checkStart(PASS, big.subarray(0, envelope.HEADER_BYTES + frame), big.length), { ok: true });
  await rejects(envelope.checkStart('wrong passphrase here', big, big.length), /does not open/, 'check: wrong passphrase');
  await rejects(envelope.checkStart(PASS, big.subarray(0, envelope.HEADER_BYTES + frame), 50), /ends early/, 'check: far too short');
  const firstFlip = Buffer.from(big); firstFlip[60] ^= 1;
  await rejects(envelope.checkStart(PASS, firstFlip, big.length), /damaged/, 'check: first block changed');
  const small = await lock(Buffer.from('tiny'));
  assert.deepStrictEqual(await envelope.checkStart(PASS, small, small.length), { ok: true }, 'check: a one-block copy is read as the last block');
  console.log('ok - locked file format');

  // ── The folder destination ──
  const usb = path.join(tmp, 'usb'); fs.mkdirSync(usb);
  const dirOf = p => createFolderDestination({ path: p }, { dataDir: tmp });
  assert.throws(() => dirOf(''), /Enter the folder/);
  assert.throws(() => dirOf('relative/path'), /full folder path/);
  assert.throws(() => dirOf('/tmp/a\0b'), /not valid/);
  await rejects(dirOf(path.join(tmp, 'no-drive', 'epilykos')).test(), /parent does not exist/, 'a missing mount is not created');
  assert.ok(!fs.existsSync(path.join(tmp, 'no-drive')), 'nothing was created under a missing parent');
  const target = path.join(usb, 'epilykos');
  const dest = dirOf(target);
  const probe = await dest.test();
  assert.strictEqual(probe.ok, true); assert.ok(fs.statSync(target).isDirectory(), 'the last folder is created');
  assert.ok(probe.warnings.some(w => /same disk/.test(w)), 'same-disk warning');
  fs.writeFileSync(path.join(usb, 'a-file'), 'x');
  await rejects(dirOf(path.join(usb, 'a-file')).test(), /file, not a folder/, 'a file is not a folder');

  const NAME = 'epilykos-backup-2026-11-13T10-00-00-abc123.epkb';
  const body = crypto.randomBytes(5000);
  const sent = await dest.put(NAME, Readable.from([body]));
  assert.strictEqual(sent.bytes, 5000); assert.strictEqual(sent.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  await dest.verify(NAME, sent);
  await rejects(dest.verify(NAME, { bytes: 5000, sha256: '0'.repeat(64) }), /does not match/, 'a mismatch is caught');
  assert.deepStrictEqual(await dest.list(), [{ name: NAME, size: 5000 }]);
  assert.ok((await collect(dest.get(NAME))).equals(body));
  for (const bad of ['../x.epkb', 'epilykos-backup-x.epkb', '/etc/passwd', NAME + '/..']) await rejects((async () => dest.get(bad))(), /not one of our/, 'name ' + bad);
  // A failed upload leaves no half file under the real name.
  const broken = new Readable({ read() { this.push(Buffer.alloc(10)); this.destroy(new Error('connection lost')); } });
  await rejects(dest.put('epilykos-backup-2026-11-13T11-00-00-def456.epkb', broken), /connection lost/, 'broken stream');
  assert.deepStrictEqual((await dest.list()).map(c => c.name), [NAME], 'no partial copy is listed');
  assert.ok(!fs.readdirSync(target).some(n => n.endsWith('.part')), 'and no part file stays');
  fs.writeFileSync(path.join(target, 'epilykos-backup-old.epkb.part'), 'x'); fs.writeFileSync(path.join(target, 'mine.txt'), 'keep');
  await dest.cleanPartial();
  assert.deepStrictEqual(fs.readdirSync(target).sort(), [NAME, 'mine.txt'], 'only unfinished uploads are removed');
  await dest.remove(NAME); await dest.remove(NAME);
  assert.deepStrictEqual(await dest.list(), []);
  console.log('ok - folder destination');

  // ── The service ──
  const snapshotFile = path.join(tmp, 'snapshot.db.gz'); fs.writeFileSync(snapshotFile, crypto.randomBytes(200000));
  let clock = Date.parse('2026-11-13T10:00:00'), snapshotAge = 3600e3, freshSnapshots = 0, events = [], restoredWith = null;
  const config = {};
  const make = (extra = {}) => createCloudBackup({
    getConfig: k => config[k] || '', setConfig: (k, v) => { config[k] = v; }, dataDir: tmp,
    latestSnapshot: () => ({ name: 's', path: snapshotFile, time: clock - snapshotAge, size: 200000 }),
    snapshotNow: async () => { freshSnapshots++; return { name: 's', path: snapshotFile, time: clock, size: 200000 }; },
    emit: (type, fields) => events.push({ type, message: fields.message }),
    restore: async file => { restoredWith = fs.readFileSync(file); return { success: true }; },
    readSpace: () => ({ available: true, available_bytes: 1e12 }), now: () => clock, ...extra
  });
  const svc = make();
  const folder = path.join(usb, 'weekly');

  assert.deepStrictEqual(svc.settings(), { enabled: false, destination: { type: 'folder', path: '' }, schedule: 'weekly', keep: 1, hasPassphrase: false }, 'off by default, weekly, keep 1');
  assert.strictEqual(svc.isDue(), false); assert.strictEqual(svc.status().nextAt, null);
  assert.throws(() => svc.saveSettings({ enabled: true, destination: { type: 'folder', path: folder } }), /Enter a passphrase/);
  assert.throws(() => svc.saveSettings({ enabled: true, destination: { type: 'folder', path: folder }, passphrase: 'short' }), /at least 8/);
  assert.throws(() => svc.saveSettings({ enabled: true, destination: { type: 'folder', path: '' }, passphrase: PASS }), /Enter the folder/);
  assert.throws(() => svc.saveSettings({ destination: { type: 'gdrive' } }), /not available yet/);
  assert.throws(() => svc.saveSettings({ schedule: 'hourly' }), /weekly or daily/);
  for (const keep of [0, 9, 1.5, 'x']) assert.throws(() => svc.saveSettings({ keep }), /1 to 8/, 'keep ' + keep);
  assert.strictEqual(config.cloud_backup, undefined, 'nothing saved by the refused attempts');

  const saved = svc.saveSettings({ enabled: true, destination: { type: 'folder', path: folder }, passphrase: PASS, keep: 1 });
  assert.deepStrictEqual(saved, { enabled: true, destination: { type: 'folder', path: folder }, schedule: 'weekly', keep: 1, hasPassphrase: true });
  assert.ok(!JSON.stringify(saved).includes(PASS) && !JSON.stringify(svc.status()).includes(PASS), 'the passphrase never comes back');
  assert.strictEqual(svc.isDue(), true, 'the first copy is due straight away');
  assert.strictEqual(svc.saveSettings({ keep: 2 }).hasPassphrase, true, 'a save without a passphrase keeps the saved one');
  svc.saveSettings({ keep: 1 });

  // First run: sent, checked, status recorded.
  const first = await svc.run();
  assert.strictEqual(first.ok, true); assert.strictEqual(freshSnapshots, 0, 'a scheduled run uses the daily snapshot');
  let copies = await svc.listCopies();
  assert.strictEqual(copies.length, 1); assert.strictEqual(copies[0].name, first.name); assert.strictEqual(copies[0].size, envelope.lockedSize(200000));
  assert.ok(!(await collect(fs.createReadStream(path.join(folder, first.name)))).includes(fs.readFileSync(snapshotFile).subarray(0, 64)), 'the file on the drive is locked');
  let st = svc.status();
  assert.strictEqual(st.lastError, null); assert.strictEqual(st.attempts, 0); assert.strictEqual(st.lastName, first.name);
  assert.strictEqual(svc.isDue(), false, 'not due again straight away');
  assert.strictEqual(timeOfName(first.name) > 0, true);

  // Weekly timing: not at day 3, not at day 7 in the afternoon, yes in the small hours, yes if a day late at any time.
  const day = 24 * 3600e3, sentAt = clock;
  clock = sentAt + 3 * day; assert.strictEqual(svc.isDue(), false, 'day 3');
  clock = new Date(new Date(sentAt + 7 * day).setHours(14, 0, 0, 0)).getTime(); if (clock < sentAt + 7 * day) clock += day;
  const afternoon = clock; assert.strictEqual(svc.isDue(), afternoon - (sentAt + 7 * day) >= day, 'afternoon of day 7 waits for the night, unless a day late');
  clock = new Date(new Date(sentAt + 8 * day).setHours(3, 0, 0, 0)).getTime(); assert.strictEqual(svc.isDue(), true, 'small hours of day 8');
  clock = sentAt + 9 * day + 5 * 3600e3; assert.strictEqual(svc.isDue(), true, 'overdue by a day: any time');

  // Replace after verify, keep 1: the older copy goes only once the new one is checked.
  clock = new Date(new Date(sentAt + 8 * day).setHours(3, 0, 0, 0)).getTime();
  const second = await svc.run();
  assert.strictEqual(second.ok, true);
  copies = await svc.listCopies();
  assert.deepStrictEqual(copies.map(c => c.name), [second.name], 'keep 1: only the new copy');
  // Keep 2 holds two.
  svc.saveSettings({ keep: 2 }); clock += day; await svc.run({ manual: true });
  assert.strictEqual((await svc.listCopies()).length, 2, 'keep 2');
  svc.saveSettings({ keep: 1 });
  assert.strictEqual(freshSnapshots, 1, 'Back up now takes a fresh snapshot');
  clock += day; snapshotAge = 40 * 3600e3; await svc.run(); assert.strictEqual(freshSnapshots, 2, 'a snapshot older than 36 hours is refreshed first'); snapshotAge = 3600e3;
  assert.strictEqual((await svc.listCopies()).length, 1);

  // A failure leaves the old copy, retries later, and warns once.
  const before = (await svc.listCopies())[0].name;
  fs.chmodSync(folder, 0o500);
  const isRoot = process.getuid && process.getuid() === 0;
  if (!isRoot) {
    clock += 8 * day; events = [];
    const failed = await svc.run();
    assert.strictEqual(failed.ok, false); assert.match(failed.error, /Cannot write/);
    assert.strictEqual((await svc.listCopies())[0].name, before, 'the earlier copy is still there');
    st = svc.status(); assert.strictEqual(st.attempts, 1); assert.match(st.lastError, /Cannot write/);
    assert.deepStrictEqual(events.map(e => e.type), ['backup.cloud_failed']);
    assert.strictEqual(svc.isDue(), false, 'no retry before the delay');
    clock += 31 * 60e3; await svc.run(); assert.strictEqual(events.length, 1, 'the second failure does not warn again within hours');
  }
  fs.chmodSync(folder, 0o700);
  // Failure by a missing drive, simulated without chmod (also works as root).
  const lostFolder = path.join(tmp, 'gone', 'epilykos');
  svc.saveSettings({ destination: { type: 'folder', path: lostFolder } });
  clock += 2 * day; events = [];
  const lost = await svc.run();
  assert.strictEqual(lost.ok, false); assert.match(lost.error, /parent does not exist/);
  assert.strictEqual(events.length, 1); assert.strictEqual(events[0].type, 'backup.cloud_failed');
  assert.ok(!fs.existsSync(path.join(tmp, 'gone')), 'a missing drive is never created on the card');
  svc.saveSettings({ destination: { type: 'folder', path: folder } });
  assert.strictEqual(svc.isDue(), true, 'saving settings again clears the wait');
  clock += 3 * 3600e3; assert.strictEqual((await svc.run()).ok, true, 'and the next run recovers');
  assert.strictEqual(svc.status().lastError, null);

  // Overdue warning, once a day.
  events = []; clock += 12 * day; svc.saveSettings({ enabled: true });
  const stale = make(); st = stale.status();
  assert.strictEqual(stale.isOverdue(), true); await stale.tick().catch(() => {});
  assert.ok(events.some(e => e.type === 'backup.cloud_overdue'), 'overdue event');
  const overdueCount = events.filter(e => e.type === 'backup.cloud_overdue').length;
  await stale.tick().catch(() => {}); assert.strictEqual(events.filter(e => e.type === 'backup.cloud_overdue').length, overdueCount, 'not repeated the same day');

  // Check a copy, and restore one.
  const copy = (await svc.listCopies())[0];
  assert.deepStrictEqual(await svc.checkCopy(copy.name), { ok: true, size: copy.size });
  await rejects(svc.checkCopy(copy.name, { passphrase: 'wrong passphrase here' }), /does not open/, 'check with a wrong passphrase');
  await rejects(svc.checkCopy('epilykos-backup-2020-01-01T00-00-00-000000.epkb'), /no longer at the destination/, 'check a missing copy');
  await rejects(svc.restoreCopy(copy.name, { passphrase: 'wrong passphrase here' }), /does not open/, 'restore with a wrong passphrase');
  assert.strictEqual(restoredWith, null, 'nothing is restored with a wrong passphrase');
  assert.deepStrictEqual(await svc.restoreCopy(copy.name), { success: true });
  assert.ok(restoredWith.equals(fs.readFileSync(snapshotFile)), 'the restore is handed exactly the snapshot that was backed up');
  assert.ok(!fs.readdirSync(tmp).some(n => n.startsWith('.cloud-restore-')), 'the downloaded file is removed afterwards');
  const tight = make({ readSpace: () => ({ available: true, available_bytes: 1000 }) });
  await rejects(tight.restoreCopy(copy.name), /Not enough free space/, 'restore needs space');
  // Switched off: nothing runs by itself.
  svc.saveSettings({ enabled: false }); assert.strictEqual(svc.isDue(), false); assert.strictEqual(svc.status().nextAt, null);
  console.log('ok - service');

  // ── The routes ──
  const express = require(path.join(REPO, 'node_modules/express'));
  const app = express(); app.use(express.json());
  app.use('/api/cloud-backup', require(path.join(REPO, 'routes/cloudBackup'))(svc, { restoreOptions: () => ({}), restoreFailure: (res, e) => res.status(500).json({ error: 'failed ' + e.message }) }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/cloud-backup`;
  const call = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, body: await r.json() }; };
  try {
    let r = await call('/'); assert.strictEqual(r.status, 200); assert.ok(!JSON.stringify(r.body).includes(PASS));
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['settings', 'status']);
    r = await call('/settings', { keep: 99 }); assert.strictEqual(r.status, 400); assert.match(r.body.error, /1 to 8/);
    r = await call('/settings', { enabled: true, destination: { type: 'folder', path: folder }, passphrase: 'short' }); assert.strictEqual(r.status, 400);
    r = await call('/settings', { enabled: true, destination: { type: 'folder', path: folder } }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.settings.enabled, true);
    r = await call('/test', { destination: { type: 'folder', path: folder } }); assert.strictEqual(r.body.ok, true);
    r = await call('/test', { destination: { type: 'folder', path: 'nope' } }); assert.strictEqual(r.status, 422); assert.match(r.body.error, /full folder path/);
    r = await call('/run', {}); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true); assert.strictEqual(freshSnapshots >= 3, true, 'Back up now from the route takes a fresh snapshot');
    r = await call('/copies'); assert.strictEqual(r.body.copies.length, 1);
    const name = r.body.copies[0].name;
    r = await call(`/copies/${name}/check`, {}); assert.strictEqual(r.body.ok, true);
    r = await call(`/copies/${name}/check`, { passphrase: 'wrong passphrase here' }); assert.strictEqual(r.status, 422);
    r = await call(`/copies/${name}/restore`, {}); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true);
    r = await call(`/copies/${encodeURIComponent('../../etc/passwd')}/restore`, {}); assert.strictEqual(r.status, 404);
  } finally { server.close(); }
  console.log('ok - routes');

  // ── Wiring ──
  const serverJs = read('server.js');
  assert.ok(serverJs.includes("app.use('/api/cloud-backup', isAuthenticated,"), 'signed in only');
  assert.ok(serverJs.includes('cloudBackup.start()'), 'the schedule runs');
  const { isProtectedKey } = require(path.join(REPO, 'modules/protectedConfig'));
  assert.ok(isProtectedKey('cloud_backup') && isProtectedKey('cloud_backup_status'), 'only its own route writes the settings');
  assert.deepStrictEqual(require(path.join(REPO, 'modules/encryption')).SECRET_FIELDS.cloud_backup, ['passphrase'], 'the passphrase is locked at rest');
  const events2 = require(path.join(REPO, 'modules/notifications/events')).EVENT_TYPES;
  for (const t of ['backup.cloud_failed', 'backup.cloud_overdue']) assert.strictEqual(events2[t].category, 'System', t);
  const html = read('public/settings.html');
  const backupSection = /id="section-backup"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(backupSection.includes('id="cloud-backup-card"') && backupSection.includes('data-own-save') && backupSection.includes('id="cb-root"'), 'the card is on the Backup page');
  assert.ok(html.includes('<script src="js/cloud-backup.js?v=1"></script>'));
  const ui = read('public/js/cloud-backup.js');
  assert.ok(ui.includes('I have saved my passphrase') && ui.includes('required'), 'the tick box is required before a new passphrase is saved');
  assert.ok(!/localStorage/.test(ui), 'the passphrase is never kept in the browser');
  const bk = require(path.join(REPO, 'modules/backup'));
  assert.strictEqual(typeof bk.latestManagedSnapshot, 'function'); assert.strictEqual(typeof bk.snapshotNow, 'function');
  console.log('ok - wired in');

  fs.rmSync(tmp, { recursive: true, force: true });
  checks.done();
})().catch(error => { console.error(error); process.exit(1); });
