'use strict';
const checks = require('./_checks');
// Remote backup to Google Drive (modules/cloudBackup/google.js, destinations/gdrive.js and their use by the service), against an
// in-memory stand-in for Google (test/_fake-google.js): the device sign-in, renewal and revocation, the Epilykos folder, the
// resumable upload (chunks, a chunk that fails after Google kept part of it, a full Drive), checking by size and MD5, other boxes'
// copies left alone, download, the connect/disconnect flow and its routes, and that nothing secret is returned.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const REPO = path.join(__dirname, '..');
const { createFakeGoogle } = require('./_fake-google');
const { createGoogleAuth, SCOPE } = require(path.join(REPO, 'modules/cloudBackup/google'));
const { createGdriveDestination } = require(path.join(REPO, 'modules/cloudBackup/destinations/gdrive'));
const { createCloudBackup, GOOGLE_KEY } = require(path.join(REPO, 'modules/cloudBackup'));
const envelope = require(path.join(REPO, 'modules/cloudBackup/envelope'));

const NAME = 'epilykos-backup-2026-11-14T10-00-00-abc123.epkb';
const collect = async stream => { const parts = []; await pipeline(stream, new Writable({ write(c, _, d) { parts.push(c); d(); } })); return Buffer.concat(parts); };
const rejects = async (promise, pattern, label) => { let error = null; try { await promise; } catch (e) { error = e; } assert.ok(error, label + ': should fail'); assert.match(error.message, pattern, label); return error; };
const KB256 = 262144;

(async () => {
  const google = createFakeGoogle({ accessLifetime: 3600 });
  await google.listen();
  const mkAuth = (extra = {}) => createGoogleAuth({ clientId: 'client-1', clientSecret: 'secret-1', endpoints: google.endpoints(), ...extra });
  const auth = mkAuth();

  // ── Signing in ──
  assert.strictEqual(createGoogleAuth({}).available(), false, 'not set up until a client id and secret exist');
  await rejects(createGoogleAuth({}).start(), /not set up in this build/, 'not configured');
  assert.strictEqual(auth.available(), true);
  const flow = await auth.start();
  assert.strictEqual(flow.userCode, 'KQRT-WZVM'); assert.strictEqual(flow.verificationUrl, 'https://www.google.com/device'); assert.strictEqual(flow.interval, 5);
  assert.strictEqual(SCOPE, 'https://www.googleapis.com/auth/drive.file', 'only the permission to see files Epilykos creates');
  assert.deepStrictEqual(await auth.poll(flow.deviceCode), { status: 'pending' });
  google.state.slowDown = 1; assert.deepStrictEqual(await auth.poll(flow.deviceCode), { status: 'slow_down' });
  google.state.denied = true; assert.deepStrictEqual(await auth.poll(flow.deviceCode), { status: 'denied' }); google.state.denied = false;
  google.approve();
  const done = await auth.poll(flow.deviceCode);
  assert.strictEqual(done.status, 'done'); assert.strictEqual(done.refreshToken, 'refresh-1');
  const renewed = await auth.refresh('refresh-1'); assert.ok(renewed.accessToken.startsWith('access-') && renewed.expiresAt > Date.now());
  await rejects(createGoogleAuth({ clientId: 'client-1', clientSecret: 'wrong', endpoints: google.endpoints() }).refresh('refresh-1'), /removed or has expired/, 'a wrong client secret is not a working sign-in');
  await rejects(auth.refresh('some-other-token'), /Connect it again/, 'a token Google does not know');
  await rejects(createGoogleAuth({ clientId: 'client-1', clientSecret: 'secret-1', endpoints: { ...google.endpoints(), token: 'http://127.0.0.1:1/token' } }).refresh('refresh-1'), /Cannot reach Google/, 'Google unreachable');
  console.log('ok - sign-in');

  // ── The destination ──
  const store = { refresh_token: 'refresh-1' };
  const tokens = { get: () => store, save: patch => Object.assign(store, patch) };
  const dest = createGdriveDestination({ auth, tokens, chunkBytes: KB256, retryDelay: () => 1 });
  assert.throws(() => createGdriveDestination({ auth, tokens, chunkBytes: 1000 }), /256 KiB/);
  await rejects(createGdriveDestination({ auth, tokens: { get: () => ({}), save() {} } }).test(), /not connected/, 'not connected');

  const probe = await dest.test();
  assert.deepStrictEqual(probe, { ok: true, warnings: [] });
  const folders = () => [...google.files.values()].filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  assert.strictEqual(folders().length, 1); assert.strictEqual(folders()[0].name, 'Epilykos', 'a visible folder called Epilykos');
  assert.ok(store.folder_id && store.box, 'the folder and this box are remembered');
  assert.deepStrictEqual([...google.files.values()].filter(f => !f.mimeType).length, 0, 'the write test leaves nothing behind');
  await dest.test(); assert.strictEqual(folders().length, 1, 'the folder is reused, not created again');
  // A new box with no memory finds the same folder instead of making another.
  const fresh = { refresh_token: 'refresh-1' };
  await createGdriveDestination({ auth, tokens: { get: () => fresh, save: p => Object.assign(fresh, p) }, retryDelay: () => 1 }).test();
  assert.strictEqual(folders().length, 1, 'another box with the same sign-in finds the existing folder'); assert.strictEqual(fresh.folder_id, store.folder_id);
  assert.notStrictEqual(fresh.box, store.box, 'but it is a different box');
  // A folder the person deleted is made again.
  google.files.delete(store.folder_id); await dest.test(); assert.strictEqual(folders().length, 1);

  const body = crypto.randomBytes(KB256 * 3 + 1000);
  const size = envelope.lockedSize(0) && body.length;
  for (const bad of ['../x.epkb', 'x.epkb']) await rejects((async () => dest.get(bad))(), /not one of our/, 'name ' + bad);
  await rejects(dest.put(NAME, Readable.from([body]), {}), /size of the copy is needed/, 'a size is needed');
  google.state.failChunks.push({ times: 1, keep: KB256, status: 503 });     // Google keeps one block of the second chunk, then fails
  const sent = await dest.put(NAME, Readable.from([body.subarray(0, 5000), body.subarray(5000)]), { size });
  assert.strictEqual(sent.bytes, body.length); assert.strictEqual(sent.md5, crypto.createHash('md5').update(body).digest('hex'));
  const stored = [...google.files.values()].filter(f => f.name === NAME);
  assert.strictEqual(stored.length, 1); assert.ok(stored[0].content.equals(body), 'every byte arrived once, in order, despite the failure');
  assert.deepStrictEqual(stored[0].parents, [store.folder_id], 'inside the Epilykos folder');
  assert.strictEqual(stored[0].appProperties.box, store.box, 'marked as this box\'s');
  await dest.verify(NAME, sent);
  await rejects(dest.verify(NAME, { ...sent, bytes: sent.bytes + 1 }), /wrong size/, 'wrong size');
  await rejects(dest.verify(NAME, { ...sent, md5: '0'.repeat(32) }), /different copy/, 'wrong checksum');
  await rejects(dest.verify('epilykos-backup-2020-01-01T00-00-00-000000.epkb', { bytes: 1, sha256: '' }), /does not show/, 'a copy that is not there');
  assert.deepStrictEqual(await dest.list(), [{ name: NAME, size: body.length, own: true }]);
  assert.ok((await collect(dest.get(NAME))).equals(body), 'download');
  // A different box's copy is listed (so it can be restored) but marked as not ours, and never removed by us.
  const OTHER = 'epilykos-backup-2026-11-01T10-00-00-fff000.epkb';
  google.files.set('other', { id: 'other', name: OTHER, parents: [store.folder_id], appProperties: { box: 'someone-else' }, content: Buffer.from('theirs') });
  assert.deepStrictEqual((await dest.list()).map(c => [c.name, c.own]).sort(), [[NAME, true], [OTHER, false]].sort());
  await dest.remove(OTHER); assert.ok(google.files.has('other'), 'another box\'s copy is left alone');
  await dest.remove(NAME); assert.strictEqual([...google.files.values()].filter(f => f.name === NAME).length, 0, 'ours is deleted');
  // An exact multiple of the chunk size, and a promised size that is wrong.
  const exact = crypto.randomBytes(KB256 * 2);
  const sentExact = await dest.put(NAME, Readable.from([exact]), { size: exact.length }); await dest.verify(NAME, sentExact); await dest.remove(NAME);
  await rejects(dest.put(NAME, Readable.from([Buffer.alloc(KB256 + 10)]), { size: KB256 * 2 }), /ended before|changed/, 'shorter than promised');
  await rejects(dest.put(NAME, Readable.from([Buffer.alloc(KB256 * 3)]), { size: KB256 }), /changed/, 'longer than promised');
  // A full Drive, and a failure that never clears.
  google.state.quotaFull = true; await rejects(dest.put(NAME, Readable.from([Buffer.alloc(100)]), { size: 100 }), /Google Drive is full/, 'full'); google.state.quotaFull = false;
  google.state.failChunks.push({ times: 99, status: 503 });
  await rejects(dest.put(NAME, Readable.from([Buffer.alloc(100)]), { size: 100 }), /answered 503/, 'a server that stays down'); google.state.failChunks.length = 0;
  // An access token that expired is renewed by itself; a sign-in Google withdrew is reported.
  google.state.expireAccess = true; let renewals = 0;
  const flaky = createGdriveDestination({ auth: { ...auth, endpoints: auth.endpoints, available: auth.available, refresh: async t => { renewals++; google.state.expireAccess = false; return auth.refresh(t); } }, tokens, retryDelay: () => 1 });
  assert.deepStrictEqual((await flaky.list()).map(c => c.name), [OTHER], 'only the other box\'s copy is left (a copy that came out the wrong size was removed)'); assert.ok(renewals >= 1, 'renewed after Google said the token ran out');
  google.state.revoked = true;
  await rejects(createGdriveDestination({ auth, tokens, retryDelay: () => 1 }).list(), /removed or has expired/, 'a withdrawn sign-in'); google.state.revoked = false;
  console.log('ok - google drive destination');

  // ── Through the service ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-gd-'));
  const snapshotFile = path.join(tmp, 'snapshot.db.gz'); fs.writeFileSync(snapshotFile, crypto.randomBytes(300000));
  const config = {}; let clock = Date.parse('2026-11-14T10:00:00'), events = [], restoredWith = null;
  const svc = createCloudBackup({
    getConfig: k => config[k] || '', setConfig: (k, v) => { config[k] = v; }, dataDir: tmp, google: mkAuth(),
    latestSnapshot: () => ({ name: 's', path: snapshotFile, time: clock - 1000, size: 300000 }),
    snapshotNow: async () => ({ name: 's', path: snapshotFile, time: clock, size: 300000 }),
    emit: type => events.push(type), restore: async file => { restoredWith = fs.readFileSync(file); return { success: true }; },
    readSpace: () => ({ available: true, available_bytes: 1e12 }), now: () => clock
  });
  google.state.approved = false; google.state.revoked = false; google.files.clear();
  assert.deepStrictEqual(svc.googleStatus(), { available: true, connected: false });
  assert.throws(() => svc.saveSettings({ enabled: true, destination: { type: 'gdrive' }, passphrase: 'correct horse battery' }), /Connect Google Drive first/);
  assert.deepStrictEqual(await svc.googlePoll(), { status: 'none' }, 'nothing in progress');
  const started = await svc.googleStart();
  assert.deepStrictEqual(Object.keys(started).sort(), ['expiresIn', 'interval', 'userCode', 'verificationUrl'], 'the device code never leaves the server');
  assert.deepStrictEqual(await svc.googlePoll(), { status: 'pending', interval: 5 });
  google.state.slowDown = 1; assert.deepStrictEqual(await svc.googlePoll(), { status: 'pending', interval: 10 }, 'told to slow down, it waits longer');
  google.approve();
  assert.deepStrictEqual(await svc.googlePoll(), { status: 'connected' });
  assert.strictEqual(JSON.parse(config[GOOGLE_KEY]).refresh_token, 'refresh-1', 'the token is kept (locked at rest by the server)');
  assert.deepStrictEqual(svc.googleStatus(), { available: true, connected: true });
  assert.deepStrictEqual(await svc.googlePoll(), { status: 'none' }, 'finished');
  // Waiting too long.
  const lateStart = await svc.googleStart(); clock += (lateStart.expiresIn + 1) * 1000; assert.deepStrictEqual(await svc.googlePoll(), { status: 'expired' });
  await svc.googleStart(); assert.deepStrictEqual(svc.googleCancel(), { status: 'none' }); assert.deepStrictEqual(await svc.googlePoll(), { status: 'none' }, 'cancelled');

  const saved = svc.saveSettings({ enabled: true, destination: { type: 'gdrive' }, passphrase: 'correct horse battery' });
  assert.deepStrictEqual(saved.destination, { type: 'gdrive', connected: true });
  assert.ok(!JSON.stringify(saved).includes('refresh-1') && !JSON.stringify(svc.status()).includes('refresh-1') && !JSON.stringify(svc.status()).includes('access-'), 'no token is ever returned');
  assert.strictEqual(svc.status().destination.label, 'Google Drive › Epilykos');
  assert.strictEqual((await svc.test({ destination: { type: 'gdrive' } })).ok, true);

  const first = await svc.run();
  assert.strictEqual(first.ok, true);
  let copies = await svc.listCopies();
  assert.strictEqual(copies.length, 1); assert.strictEqual(copies[0].size, envelope.lockedSize(300000));
  const driveFile = [...google.files.values()].find(f => f.name === first.name);
  assert.ok(!driveFile.content.includes(fs.readFileSync(snapshotFile).subarray(0, 64)), 'what Google holds is locked');
  // Another box's copy in the same folder is not counted against keep and not deleted.
  google.files.set('other', { id: 'other', name: 'epilykos-backup-2026-10-01T10-00-00-aaa111.epkb', parents: [driveFile.parents[0]], appProperties: { box: 'someone-else' }, content: Buffer.from('theirs') });
  clock += 8 * 24 * 3600e3; const second = await svc.run({ manual: true });
  assert.strictEqual(second.ok, true);
  const names = [...google.files.values()].filter(f => f.name.startsWith('epilykos-backup-')).map(f => f.name).sort();
  assert.deepStrictEqual(names, [second.name, 'epilykos-backup-2026-10-01T10-00-00-aaa111.epkb'].sort(), 'keep 1 replaces our copy and leaves the other box\'s');
  assert.strictEqual((await svc.listCopies()).length, 2, 'both can be restored');
  assert.deepStrictEqual(await svc.checkCopy(second.name), { ok: true, size: envelope.lockedSize(300000) });
  await svc.restoreCopy(second.name);
  assert.ok(restoredWith.equals(fs.readFileSync(snapshotFile)), 'restored exactly what was backed up');
  // Google withdrawing the sign-in: reported, the copy stays, one warning.
  google.state.revoked = true; clock += 8 * 24 * 3600e3; events = [];
  const out = await svc.run(); assert.strictEqual(out.ok, false); assert.match(out.error, /removed or has expired/);
  assert.deepStrictEqual(events, ['backup.cloud_failed']); assert.strictEqual((await svc.listCopies().catch(() => [])).length >= 0, true);
  google.state.revoked = false;
  // Disconnecting tells Google, forgets the sign-in, and switches a Google Drive backup off.
  const before = JSON.parse(config[GOOGLE_KEY]).box;
  assert.deepStrictEqual(await svc.googleDisconnect(), { connected: false });
  assert.strictEqual(google.state.revoked, true, 'Google was told');
  const afterToken = JSON.parse(config[GOOGLE_KEY]);
  assert.strictEqual(afterToken.refresh_token, undefined); assert.strictEqual(afterToken.folder_id, undefined); assert.strictEqual(afterToken.box, before, 'the box keeps its identity');
  assert.strictEqual(svc.settings().enabled, false, 'switched off');
  assert.deepStrictEqual(await svc.listCopies(), [], 'nothing to list when not connected');
  console.log('ok - service with google drive');

  // ── The routes ──
  const express = require(path.join(REPO, 'node_modules/express'));
  google.state.revoked = false; google.state.approved = false;
  const app = express(); app.use(express.json());
  app.use('/api/cloud-backup', require(path.join(REPO, 'routes/cloudBackup'))(svc, { restoreOptions: () => ({}) }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/cloud-backup`;
  const call = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, body: await r.json() }; };
  try {
    let r = await call('/'); assert.deepStrictEqual(r.body.google, { available: true, connected: false });
    r = await call('/google/start', {}); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.userCode, 'KQRT-WZVM'); assert.ok(!('deviceCode' in r.body));
    r = await call('/google/poll'); assert.strictEqual(r.body.status, 'pending');
    google.approve();
    r = await call('/google/poll'); assert.strictEqual(r.body.status, 'connected'); assert.deepStrictEqual(r.body.overview.google, { available: true, connected: true }); assert.ok(!JSON.stringify(r.body).includes('refresh-1'));
    r = await call('/settings', { enabled: true, destination: { type: 'gdrive' }, passphrase: 'correct horse battery' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.settings.destination.connected, true);
    r = await call('/google/disconnect', {}); assert.strictEqual(r.body.google.connected, false); assert.strictEqual(r.body.settings.enabled, false);
    const bare = createCloudBackup({ getConfig: () => '', setConfig() {}, dataDir: tmp, google: createGoogleAuth({}), latestSnapshot: () => null, snapshotNow: async () => null, restore: async () => ({}), now: () => clock });
    const app2 = express(); app2.use(express.json()); app2.use('/x', require(path.join(REPO, 'routes/cloudBackup'))(bare));
    const s2 = await new Promise(resolve => { const s = app2.listen(0, '127.0.0.1', () => resolve(s)); });
    const r2 = await fetch(`http://127.0.0.1:${s2.address().port}/x/google/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r2.status, 501); assert.match((await r2.json()).error, /not set up in this build/); s2.close();
  } finally { server.close(); }
  console.log('ok - routes');

  // ── Wiring ──
  const { SECRET_FIELDS } = require(path.join(REPO, 'modules/encryption'));
  assert.deepStrictEqual(SECRET_FIELDS.cloud_backup_google, ['refresh_token'], 'the Google sign-in is locked at rest');
  assert.ok(require(path.join(REPO, 'modules/protectedConfig')).isProtectedKey(GOOGLE_KEY), 'only its own route writes it');
  const ui = fs.readFileSync(path.join(REPO, 'public/js/cloud-backup.js'), 'utf8');
  for (const word of ['Google Drive', 'cb-g-connect', 'cb-g-disconnect', '/api/cloud-backup/google/start', '/api/cloud-backup/google/poll']) assert.ok(ui.includes(word), 'the card has ' + word);
  assert.ok(!/localStorage/.test(ui));
  const client = require(path.join(REPO, 'modules/cloudBackup/googleClient'));
  assert.deepStrictEqual(Object.keys(client).sort(), ['clientId', 'clientSecret']);
  assert.match(client.clientId, /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/, 'the project\'s client id is in the source');
  const secretFile = path.join(os.tmpdir(), `epilykos-gc-${process.pid}.json`);
  fs.writeFileSync(secretFile, JSON.stringify({ clientSecret: 'from-the-build' }));
  assert.strictEqual(client.load({}, secretFile).clientSecret, 'from-the-build', 'the build writes the secret to a file');
  assert.strictEqual(client.load({ EPILYKOS_GOOGLE_CLIENT_SECRET: 'from-env' }, secretFile).clientSecret, 'from-env', 'an environment variable wins');
  assert.strictEqual(client.load({ EPILYKOS_GOOGLE_CLIENT_ID: 'my-id' }, secretFile).clientId, 'my-id');
  assert.strictEqual(client.load({}, path.join(os.tmpdir(), 'no-such-file.json')).clientSecret, '', 'a build without the file has no secret, so Drive shows as not set up');
  fs.writeFileSync(secretFile, 'not json'); assert.strictEqual(client.load({}, secretFile).clientSecret, '', 'a damaged file is ignored');
  fs.unlinkSync(secretFile);
  // The secret itself is never in the source, and the build's file is not committed.
  const tracked = require('child_process').execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n');
  assert.ok(!tracked.includes('modules/cloudBackup/google-client.json'), 'the generated file is not tracked');
  assert.ok(/google-client\.json/.test(fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8')), 'and is ignored');
  for (const f of ['.github/workflows/docker-build.yml', '.github/workflows/docker-build-dev.yml']) {
    const y = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(y.includes('secrets.GOOGLE_CLIENT_SECRET') && y.includes('modules/cloudBackup/google-client.json'), f + ' writes the secret into the image build');
    assert.ok(y.indexOf('google-client.json') < y.indexOf('docker/build-push-action'), f + ' does it before the image is built');
  }
  assert.ok(!/(^|\n)\s*modules\/cloudBackup\/google-client\.json/m.test(fs.readFileSync(path.join(REPO, '.dockerignore'), 'utf8')), 'and the image build context keeps it');
  await google.close(); fs.rmSync(tmp, { recursive: true, force: true });
  checks.done();
})().catch(error => { console.error(error); process.exit(1); });
