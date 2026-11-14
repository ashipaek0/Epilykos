'use strict';
const checks = require('./_checks');
// Remote backup to a WebDAV server (modules/cloudBackup/destinations/webdav.js and its use by the service), against a small
// in-memory server (test/_fake-webdav.js): parts and a manifest, a server that caps request size, retries, listing, removal,
// leftovers, wrong sign-in, redirects, a pinned self-signed certificate, and the settings (the password is kept and never returned).
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const REPO = path.join(__dirname, '..');
const { createFakeWebdav } = require('./_fake-webdav');
const { createWebdavDestination, parseSettings } = require(path.join(REPO, 'modules/cloudBackup/destinations/webdav'));
const { createCloudBackup } = require(path.join(REPO, 'modules/cloudBackup'));
const envelope = require(path.join(REPO, 'modules/cloudBackup/envelope'));

const NAME = 'epilykos-backup-2026-11-14T10-00-00-abc123.epkb';
const collect = async stream => { const parts = []; await pipeline(stream, new Writable({ write(c, _, d) { parts.push(c); d(); } })); return Buffer.concat(parts); };
const rejects = async (promise, pattern, label) => { let error = null; try { await promise; } catch (e) { error = e; } assert.ok(error, label + ': should fail'); assert.match(error.message, pattern, label); return error; };
const base = { folder: 'Epilykos', username: 'ade', password: 'app-password' };
const quick = { partBytes: 40000, retryDelay: () => 1 };

(async () => {
  // ── What is typed ──
  assert.throws(() => parseSettings({ ...base, url: '' }), /server address/);
  assert.throws(() => parseSettings({ ...base, url: 'ftp://host/dav/' }), /https:\/\/ or http:\/\//);
  assert.throws(() => parseSettings({ ...base, url: 'https://ade:secret@host/dav/' }), /own boxes/);
  assert.throws(() => parseSettings({ ...base, url: 'https://host/dav/?x=1' }), /\?/);
  assert.throws(() => parseSettings({ ...base, url: 'https://host/dav/', folder: '../up' }), /not valid/);
  assert.throws(() => parseSettings({ ...base, url: 'https://host/dav/', certificate: 'not a certificate' }), /not a certificate/);
  assert.throws(() => parseSettings({ ...base, url: 'http://host/dav/', certificate: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' }), /only applies to an https/);
  assert.throws(() => parseSettings({ ...base, url: 'https://host/dav/', username: '' }), /username/);
  assert.throws(() => parseSettings({ ...base, url: 'https://host/dav/', password: '' }), /password/);
  assert.strictEqual(parseSettings({ ...base, url: 'https://host/dav/', folder: '/Epilykos/' }).folder, 'Epilykos', 'slashes around the folder are dropped');

  // ── The destination, against a server that refuses requests over 100 KB ──
  const dav = createFakeWebdav({ maxBody: 100000 });
  const url = await dav.listen();
  const dest = createWebdavDestination({ ...base, url }, quick);
  const probe = await dest.test();
  assert.strictEqual(probe.ok, true); assert.ok(probe.warnings.some(w => /not encrypted/.test(w)), 'plain http is flagged');
  assert.ok(dav.dirs.has('/dav/Epilykos'), 'the folder was created');
  assert.ok([...dav.files.keys()].every(k => !k.includes('write-test')), 'the write test leaves nothing behind');

  const body = crypto.randomBytes(250000);
  dav.state.failPut.push({ suffix: '.p0002', times: 1, status: 503 });
  const sent = await dest.put(NAME, Readable.from([body.subarray(0, 1000), body.subarray(1000)]), { size: body.length });
  assert.strictEqual(sent.bytes, 250000); assert.strictEqual(sent.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  const stored = [...dav.files.keys()].map(k => k.split('/').pop()).sort();
  assert.strictEqual(stored.length, 8, 'seven parts and the record'); assert.ok(stored.includes(NAME));
  assert.ok([...dav.files.entries()].filter(([k]) => /\.p\d{4}$/.test(k)).every(([, b]) => b.length <= 40000), 'no part is over the part size, so a size-capped server accepts it');
  assert.deepStrictEqual(dav.log.filter(l => l.startsWith('PUT') && l.endsWith('.p0002')).length, 2, 'the failed part was sent again');
  const lastPut = dav.log.filter(l => l.startsWith('PUT')).pop(); assert.ok(lastPut.endsWith(NAME), 'the record is written last');
  await dest.verify(NAME, sent);
  await rejects(dest.verify(NAME, { bytes: sent.bytes, sha256: '0'.repeat(64) }), /different copy/, 'a different copy');
  const partKey = [...dav.files.keys()].find(k => k.endsWith('.p0003')); const keep = dav.files.get(partKey);
  dav.files.set(partKey, keep.subarray(0, 10));
  await rejects(dest.verify(NAME, sent), /part 3.*wrong size/, 'a short part');
  dav.files.set(partKey, keep);
  assert.deepStrictEqual(await dest.list(), [{ name: NAME, size: 250000 }]);
  assert.ok((await collect(dest.get(NAME))).equals(body), 'downloaded and joined in order');
  dav.state.failGet.push({ suffix: '.p0004', times: 1, status: 503 });
  assert.ok((await collect(dest.get(NAME))).equals(body), 'a failed part download is retried');

  // A copy cut short has parts but no record: it is not listed, and the next run clears the parts.
  const CUT = 'epilykos-backup-2026-11-14T11-00-00-def456.epkb';
  dav.files.set(`/dav/Epilykos/${CUT}.p0001`, Buffer.alloc(100));
  assert.deepStrictEqual((await dest.list()).map(c => c.name), [NAME]);
  await dest.cleanPartial();
  assert.ok(!dav.files.has(`/dav/Epilykos/${CUT}.p0001`), 'leftover parts are removed');
  assert.ok(dav.files.has(`/dav/Epilykos/${NAME}`) && dav.files.has(`/dav/Epilykos/${NAME}.p0001`), 'a finished copy is left alone');
  dav.files.set('/dav/Epilykos/notes.txt', Buffer.from('mine'));
  await dest.remove(NAME);
  assert.deepStrictEqual([...dav.files.keys()], ['/dav/Epilykos/notes.txt'], 'a copy and its parts are removed, nothing else');
  assert.deepStrictEqual(await dest.list(), []);
  for (const bad of ['../x.epkb', 'x.epkb', NAME + '/..']) await rejects((async () => dest.get(bad))(), /not one of our/, 'name ' + bad);
  // An exactly-full last part, and an empty body.
  const exact = await dest.put(NAME, Readable.from([crypto.randomBytes(80000)]), { size: 80000 });
  assert.strictEqual([...dav.files.keys()].filter(k => /\.p\d{4}$/.test(k)).length, 2, 'two full parts, no empty third'); await dest.verify(NAME, exact); await dest.remove(NAME);
  await rejects(dest.put(NAME, Readable.from([Buffer.alloc(10)]), { size: 99 }), /changed while/, 'size mismatch');

  // ── Servers that say no ──
  await rejects(createWebdavDestination({ ...base, url, password: 'wrong' }, quick).test(), /username and password/, 'wrong password');
  dav.state.redirect = true;
  await rejects(dest.test(), /redirected to https:\/\/elsewhere\.example/, 'a redirect is reported, not followed');
  dav.state.redirect = false;
  await rejects(createWebdavDestination({ ...base, url: url.replace('/dav/', '/nothing/') }, quick).test(), /does not exist/, 'a wrong address');
  await rejects(createWebdavDestination({ ...base, url: url.replace('/dav/', '/dav/missing/'), folder: 'Deep/er' }, quick).test(), /does not exist|parent/, 'a missing parent is not created');
  await rejects(createWebdavDestination({ ...base, url: 'http://127.0.0.1:1/dav/' }, quick).test(), /Cannot reach/, 'nothing listening');
  const slow = createWebdavDestination({ ...base, url }, { ...quick, requestTimeout: 50 });
  assert.ok(slow, 'a short timeout is accepted');
  console.log('ok - webdav destination');

  // ── Through the service ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-dav-'));
  const snapshotFile = path.join(tmp, 'snapshot.db.gz'); fs.writeFileSync(snapshotFile, crypto.randomBytes(300000));
  const config = {}; let clock = Date.parse('2026-11-14T10:00:00'), events = [], restoredWith = null;
  const svc = createCloudBackup({
    getConfig: k => config[k] || '', setConfig: (k, v) => { config[k] = v; }, dataDir: tmp,
    latestSnapshot: () => ({ name: 's', path: snapshotFile, time: clock - 1000, size: 300000 }),
    snapshotNow: async () => ({ name: 's', path: snapshotFile, time: clock, size: 300000 }),
    emit: (type) => events.push(type), restore: async file => { restoredWith = fs.readFileSync(file); return { success: true }; },
    readSpace: () => ({ available: true, available_bytes: 1e12 }), now: () => clock,
    makeDestination: settings => settings.type === 'webdav' ? createWebdavDestination(settings, quick) : (() => { throw new Error('unexpected'); })()
  });
  const typed = { type: 'webdav', url, folder: 'Backups', username: 'ade', password: 'app-password', certificate: '' };
  assert.throws(() => svc.saveSettings({ enabled: true, destination: { ...typed, password: '' }, passphrase: 'correct horse battery' }), /Enter the password/);
  const saved = svc.saveSettings({ enabled: true, destination: typed, passphrase: 'correct horse battery' });
  assert.deepStrictEqual(saved.destination, { type: 'webdav', url, folder: 'Backups', username: 'ade', certificate: '', hasPassword: true });
  assert.ok(!JSON.stringify(saved).includes('app-password') && !JSON.stringify(svc.status()).includes('app-password'), 'the password never comes back');
  assert.strictEqual(svc.status().destination.label, new URL(url).host + '/Backups');
  // Saving again without the password keeps it; changing the server or user asks for it again.
  assert.strictEqual(svc.saveSettings({ destination: { ...typed, password: '' } }).destination.hasPassword, true, 'blank keeps the saved password');
  assert.throws(() => svc.saveSettings({ destination: { ...typed, username: 'someone-else', password: '' } }), /Enter the password/, 'a different user needs the password');
  assert.throws(() => svc.saveSettings({ destination: { ...typed, url: url + 'other/', password: '' } }), /Enter the password/, 'a different server needs the password');
  assert.deepStrictEqual((await svc.test({ destination: { ...typed, password: '' } })).ok, true, 'Test connection uses the saved password for the same server');
  await rejects(svc.test({ destination: { ...typed, password: 'wrong' } }), /username and password/, 'Test connection with a wrong password');
  assert.ok(!/app-password/.test(config.cloud_backup) === false, 'stored in the settings row (locked at rest by the server)');

  const first = await svc.run();
  assert.strictEqual(first.ok, true);
  const copies = await svc.listCopies();
  assert.strictEqual(copies.length, 1); assert.strictEqual(copies[0].size, envelope.lockedSize(300000));
  const onServer = [...dav.files.entries()].filter(([k]) => k.includes('/Backups/'));
  assert.ok(onServer.length >= 2, 'stored as parts and a record');
  assert.ok(!Buffer.concat(onServer.map(([, b]) => b)).includes(fs.readFileSync(snapshotFile).subarray(0, 64)), 'nothing readable on the server');
  // Keep 1: a second copy replaces the first, and the old parts go with it.
  clock += 8 * 24 * 3600e3; const second = await svc.run({ manual: true });
  assert.strictEqual(second.ok, true);
  assert.deepStrictEqual((await svc.listCopies()).map(c => c.name), [second.name]);
  assert.ok([...dav.files.keys()].filter(k => k.includes('/Backups/')).every(k => k.includes(second.name)), 'the first copy and its parts are gone');
  // Check, restore.
  assert.deepStrictEqual(await svc.checkCopy(second.name), { ok: true, size: envelope.lockedSize(300000) });
  await rejects(svc.checkCopy(second.name, { passphrase: 'wrong passphrase here' }), /does not open/, 'check, wrong passphrase');
  await svc.restoreCopy(second.name);
  assert.ok(restoredWith.equals(fs.readFileSync(snapshotFile)), 'the restore gets exactly the snapshot that was backed up');
  // A failing server leaves the earlier copy and records the reason.
  dav.state.failPut.push({ suffix: '.p0001', times: 99, status: 507 });
  clock += 8 * 24 * 3600e3; events = [];
  const out = await svc.run(); assert.strictEqual(out.ok, false); assert.match(out.error, /out of space/);
  assert.deepStrictEqual(events, ['backup.cloud_failed']);
  assert.deepStrictEqual((await svc.listCopies()).map(c => c.name), [second.name], 'the earlier copy is still there');
  dav.state.failPut.length = 0;
  await dav.close();
  console.log('ok - service with webdav');

  // ── A server with its own certificate: refused until that certificate is pasted, and then only that one is trusted ──
  let haveOpenssl = true;
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-cert-'));
  const makeCert = (name, subject, san) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, name + '-k.pem'), '-out', path.join(certDir, name + '-c.pem'), '-days', '2', '-subj', subject, ...(san ? ['-addext', 'subjectAltName=' + san] : [])], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(certDir, name + '-k.pem')), cert: fs.readFileSync(path.join(certDir, name + '-c.pem'), 'utf8') };
  };
  let one, two, nameless;
  try { one = makeCert('one', '/CN=127.0.0.1', 'IP:127.0.0.1'); two = makeCert('two', '/CN=127.0.0.1', 'IP:127.0.0.1'); nameless = makeCert('nameless', '/CN=somewhere-else.example'); } catch (_) { haveOpenssl = false; }
  if (haveOpenssl) {
    const tlsDav = createFakeWebdav({ tls: { key: one.key, cert: one.cert } });
    const tlsUrl = await tlsDav.listen();
    const e = await rejects(createWebdavDestination({ ...base, url: tlsUrl }, quick).test(), /not trusted/, 'a self-signed certificate is refused');
    assert.ok(/certificate box/.test(e.message), 'and the message says what to do');
    const pasted = await createWebdavDestination({ ...base, url: tlsUrl, certificate: one.cert }, quick).test();
    assert.strictEqual(pasted.ok, true, 'accepted once its certificate is pasted'); assert.deepStrictEqual(pasted.warnings, [], 'https carries no warning');
    await rejects(createWebdavDestination({ ...base, url: tlsUrl, certificate: two.cert }, quick).test(), /not the one you pasted/, 'a different certificate is refused');
    // The pasted certificate is trusted for its own server, whatever name it is reached by; nothing else gets that trust.
    const namelessDav = createFakeWebdav({ tls: { key: nameless.key, cert: nameless.cert } });
    const namelessUrl = await namelessDav.listen();
    await rejects(createWebdavDestination({ ...base, url: namelessUrl }, quick).test(), /not trusted/, 'a certificate for another name is refused on its own');
    assert.strictEqual((await createWebdavDestination({ ...base, url: namelessUrl, certificate: nameless.cert }, quick).test()).ok, true, 'but accepted when it is the pasted one');
    await rejects(createWebdavDestination({ ...base, url: tlsUrl, certificate: nameless.cert }, quick).test(), /not the one you pasted/, 'and the pasted one is not trusted for other servers');
    // A real run through the destination over that connection, to be sure the trust holds for uploads too.
    const secure = createWebdavDestination({ ...base, url: tlsUrl, certificate: one.cert }, quick);
    const small = crypto.randomBytes(90000);
    const sentSecure = await secure.put(NAME, Readable.from([small]), { size: small.length }); await secure.verify(NAME, sentSecure);
    assert.ok((await collect(secure.get(NAME))).equals(small), 'upload and download over a pinned connection'); await secure.remove(NAME);
    await tlsDav.close(); await namelessDav.close();
    console.log('ok - pasted certificate');
  } else console.log('skipped - pasted certificate (no openssl)');
  // Certificate validation is never switched off.
  assert.ok(!/rejectUnauthorized\s*:\s*false/.test(fs.readFileSync(path.join(REPO, 'modules/cloudBackup/destinations/webdav.js'), 'utf8')), 'the destination never turns certificate validation off');

  // ── Wiring ──
  const ui = fs.readFileSync(path.join(REPO, 'public/js/cloud-backup.js'), 'utf8');
  for (const word of ['cb-dest', 'cb-w-url', 'cb-w-user', 'cb-w-pass', 'cb-w-folder', 'cb-w-cert', 'WebDAV']) assert.ok(ui.includes(word), 'the card has ' + word);
  assert.ok(!/localStorage/.test(ui));
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(certDir, { recursive: true, force: true });
  checks.done();
})().catch(error => { console.error(error); process.exit(1); });
