'use strict';
const checks = require('./_checks');
/**
 * Settings → Updates must not offer the version that is already running.
 * The saved check results ("1.1.2 is ready") are from before the install;
 * after the app restarts on that version they are dropped:
 * - the feed result, when this build is the one it offers (or newer);
 * - the appliance result, when the host says the offered digest is installed;
 * - an offer that is still newer than what runs stays.
 */
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-offer-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.EPILYKOS_HOST_SOCKET;
Object.assign(process.env, { EPILYKOS_CHANNEL: 'stable', EPILYKOS_BUILD_ID: '200.1', EPILYKOS_COMMIT: 'b'.repeat(40), EPILYKOS_BUILT_AT: '2026-11-08T09:49:23Z' });

const express = require('express');
const database = require('../modules/database');
database.initializeDatabase();
const updates = require('../modules/updates');
const hostActions = require('../modules/hostActions');
const mine = updates.installed();
const NEW = 'sha256:' + 'c'.repeat(64), OLD = 'sha256:' + 'd'.repeat(64);

// Pure: the feed result.
const offered = (id, at) => ({ state: 'available', kind: 'release', behind: 1, latest: { buildId: id, version: '1.1.2', builtAt: at }, checkedAt: 'x' });
assert.equal(updates.reconcileStatus(offered('200.1', '2026-11-08T09:49:23Z'), mine).state, 'up-to-date', 'this very build');
assert.equal(updates.reconcileStatus(offered('199.9', '2026-11-08T09:00:00Z'), mine).state, 'up-to-date', 'an older build than this one');
assert.equal(updates.reconcileStatus(offered('201.1', '2026-11-09T09:00:00Z'), mine).state, 'available', 'a newer build is still offered');
assert.deepEqual(updates.reconcileStatus({ state: 'error', error: 'x' }, mine), { state: 'error', error: 'x' });
assert.equal(updates.reconcileStatus(null, mine), null);

// Pure: the appliance result.
const hostResult = (latest, extra) => ({ supported: true, checkedAt: 'x', app: Object.assign({ available: true, latest_version: '1.1.2', latest_digest: latest, current_digest: OLD, current_version: '1.1.1' }, extra) });
let r = updates.reconcileHostStatus(hostResult(NEW), { digest: NEW, version: '1.1.2' });
assert.equal(r.app.available, false); assert.equal(r.app.current_version, '1.1.2'); assert.equal(r.app.current_digest, NEW);
assert.equal(r.app.latest_version, '1.1.2', 'what was checked is kept');
r = updates.reconcileHostStatus(hostResult(NEW), { digest: OLD, version: '1.1.1' });
assert.equal(r.app.available, true, 'still behind');
const untouched = hostResult(NEW);
assert.equal(updates.reconcileHostStatus(untouched, null), untouched, 'host unreachable: unchanged');
assert.equal(updates.reconcileHostStatus(null, { digest: NEW }), null);
const upToDate = { supported: true, app: { available: false } };
assert.equal(updates.reconcileHostStatus(upToDate, { digest: NEW }), upToDate);

(async () => {
  // Through the route, as the page loads it.
  hostActions.available = () => true;
  let running = { current_digest: OLD, current_version: '1.1.1', state: 'idle', job: null, last_result: null };
  hostActions.call = async action => (action === 'update_status' ? { ok: true, app: running } : { ok: true });
  const router = require('../routes/updates').router();
  const app = express(); app.use(express.json()); app.use('/api/updates', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = () => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/updates' }, res => {
    let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(JSON.parse(d)));
  }).on('error', reject));

  database.setConfig('update_host_status', JSON.stringify(hostResult(NEW)));
  database.setConfig('update_status', JSON.stringify(offered('200.1', '2026-11-08T09:49:23Z')));
  let page = await get();
  assert.equal(page.host.app.available, true, 'the appliance still runs 1.1.1: the offer stands');
  assert.equal(page.status.state, 'up-to-date', 'the feed result is about this build');

  running = { current_digest: NEW, current_version: '1.1.2', state: 'idle', job: null, last_result: { ok: true, release: '1.1.2', sequence: 21, finished_at: 'z' } };
  page = await get();
  assert.equal(page.host.app.available, false, 'after the update the appliance offer is gone');
  assert.equal(page.host.app.current_version, '1.1.2');
  server.close();
  console.log('ok - saved update offers are dropped once that version is running');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
