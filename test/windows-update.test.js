'use strict';
// Updates for the Windows installer build: version comparison, picking the installer, and the safe download.
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-winupd-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
process.env.EPILYKOS_VERSION = '1.2.0';
require('../modules/database').initializeDatabase();
const wu = require('../modules/windowsUpdate');

assert.deepEqual(wu.parseVersion('v1.2.3'), [1, 2, 3]);
assert.deepEqual(wu.parseVersion('1.0.4-dev+abc1234'), [1, 0, 4]);
assert.equal(wu.parseVersion('nonsense'), null);
assert.ok(wu.isNewer('1.10.0', '1.9.9') && wu.isNewer('2.0.0', '1.99.99'));
assert.ok(!wu.isNewer('1.2.0', '1.2.0') && !wu.isNewer('1.1.9', '1.2.0') && !wu.isNewer('x', '1.2.0'));

const payload = Buffer.from('pretend installer bytes');
const sha = crypto.createHash('sha256').update(payload).digest('hex');
const asset = (over = {}) => ({ name: 'Epilykos-Setup-1.3.0.exe', size: payload.length, digest: 'sha256:' + sha,
  browser_download_url: wu.DOWNLOAD_PREFIX + 'v1.3.0/Epilykos-Setup-1.3.0.exe', ...over });
const release = (over = {}) => ({ tag_name: 'v1.3.0', published_at: '2026-11-20T00:00:00Z', body: 'Notes', assets: [asset()], ...over });

assert.equal(wu.pickAsset(release()).sha256, sha);
assert.equal(wu.pickAsset({ assets: [asset({ name: 'something.zip' })] }), null);
assert.equal(wu.pickAsset({ assets: [asset({ browser_download_url: 'https://evil.example/Epilykos-Setup-1.3.0.exe' })] }), null, 'only this project\'s releases');
assert.equal(wu.pickAsset({ assets: [asset({ digest: null })] }).sha256, null);

let served = release();
let body = payload;
const calls = [];
const fakeFetch = async (url) => {
  calls.push(url);
  if (String(url).includes('api.github.com')) return { ok: true, status: 200, json: async () => served };
  return { ok: true, status: 200, body: new Response(body).body };
};
const launched = [];
wu.setForTests({ fetch: fakeFetch, tmp: () => tmp, spawn: (file, args) => { launched.push([file, args]); return { unref() {} }; } });

(async () => {
  let r = await wu.check();
  assert.equal(r.state, 'available'); assert.equal(r.latest.version, '1.3.0'); assert.equal(r.asset.verifiable, true);
  assert.equal(wu.status().state, 'available');

  served = release({ tag_name: 'v1.2.0' });
  r = await wu.check();
  assert.equal(r.state, 'up-to-date');
  served = release({ assets: [] });
  r = await wu.check();
  assert.equal(r.state, 'up-to-date'); assert.match(r.note, /no Windows installer/);
  wu.setForTests({ fetch: async () => ({ ok: false, status: 403 }) });
  r = await wu.check();
  assert.equal(r.state, 'error'); assert.match(r.error, /403/);
  wu.setForTests({ fetch: fakeFetch });

  // apply() only on the Windows installer build
  await assert.rejects(wu.apply(), /not the Windows installer/);
  assert.equal(wu.isWindowsInstall(), false);
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.EPILYKOS_INSTALLER = 'windows';
  try {
    served = release();
    const out = await wu.apply();
    assert.equal(out.state, 'applying');
    assert.equal(launched.length, 1);
    assert.match(path.basename(launched[0][0]), /^Epilykos-Setup-1\.3\.0\.exe$/);
    assert.ok(launched[0][1].includes('/VERYSILENT') && launched[0][1].includes('/CLOSEAPPLICATIONS'));
    assert.deepEqual(fs.readFileSync(launched[0][0]), payload);

    // A download that does not match its checksum is never run
    launched.length = 0; body = Buffer.from('tampered'); 
    wu.setForTests({ fetch: fakeFetch });
    await assert.rejects(wu.apply(), /did not match its checksum/);
    assert.equal(launched.length, 0);
    assert.equal(wu.progress(), null);

    // No published checksum: refused
    body = payload; served = release({ assets: [asset({ digest: null })] });
    await assert.rejects(wu.apply(), /checksum/);
    // Not newer: refused
    served = release({ tag_name: 'v1.2.0' });
    await assert.rejects(wu.apply(), /already the newest/);
  } finally { Object.defineProperty(process, 'platform', real); delete process.env.EPILYKOS_INSTALLER; }
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
