'use strict';
const checks = require('./_checks');
// How far a Docker image pull has got, from the lines Docker streams
// (modules/pullProgress.js), and the Docker client passing those lines on as
// they arrive (modules/dockerApi.js onLine).
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createPullProgress } = require('../modules/pullProgress');
const dockerApi = require('../modules/dockerApi');

const L = (id, status, current, total) => ({ id, status, progressDetail: current === undefined ? {} : { current, total } });
const A = 'a'.repeat(12), B = 'b'.repeat(12), C = 'c'.repeat(12), D = 'd'.repeat(12);

(async () => {
  // Nothing yet, or only the tag line: nothing known.
  let p = createPullProgress();
  p.add({ status: 'Pulling from irunmole/epilykos', id: 'latest' });
  assert.deepEqual(p.snapshot(), { bytes: 0, total: null });

  // A layer whose size is not known yet keeps the total unknown (no bar that jumps back).
  p.add(L(A, 'Pulling fs layer')); p.add(L(B, 'Pulling fs layer'));
  p.add(L(A, 'Downloading', 10, 100));
  assert.deepEqual(p.snapshot(), { bytes: 10, total: null });
  p.add(L(B, 'Downloading', 0, 300));
  assert.deepEqual(p.snapshot(), { bytes: 10, total: 400 });
  p.add(L(A, 'Downloading', 100, 100)); p.add(L(A, 'Verifying Checksum')); p.add(L(A, 'Download complete'));
  p.add(L(B, 'Downloading', 150, 300));
  assert.deepEqual(p.snapshot(), { bytes: 250, total: 400 });

  // A finished layer counts in full; extracting does not move the bar.
  p.add(L(B, 'Download complete')); p.add(L(B, 'Extracting', 10, 999)); p.add(L(B, 'Pull complete'));
  assert.deepEqual(p.snapshot(), { bytes: 400, total: 400 });
  console.log('ok - layers add up; the total stays unknown until every layer has a size');

  // Layers Docker already has are not part of the download.
  p = createPullProgress();
  p.add(L(C, 'Already exists')); p.add(L(D, 'Pulling fs layer')); p.add(L(D, 'Downloading', 5, 50));
  assert.deepEqual(p.snapshot(), { bytes: 5, total: 50 });
  p = createPullProgress();
  p.add(L(C, 'Already exists'));
  assert.deepEqual(p.snapshot(), { bytes: 0, total: null }, 'all layers present: nothing to show');
  console.log('ok - layers Docker already has are left out');

  // Odd input never throws and never counts.
  p = createPullProgress();
  for (const junk of [null, 5, 'x', {}, { id: A }, { status: 'Downloading' }, L(A, 'Downloading', -5, 'big'), L(A, 'Downloading', 10, 0), L('zz', 'Downloading', 1, 2)]) p.add(junk);
  assert.deepEqual(p.snapshot(), { bytes: 0, total: null });
  p.add(L(A, 'Downloading', 500, 100));
  assert.deepEqual(p.snapshot(), { bytes: 100, total: 100 }, 'never past the layer\'s own size');
  console.log('ok - malformed lines are ignored');

  // The Docker client hands each line over as it arrives, even split across chunks,
  // and still resolves the same array.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-docker-'));
  const sock = path.join(dir, 'docker.sock');
  const lines = [L(A, 'Downloading', 1, 4), L(A, 'Downloading', 2, 4), { status: 'Status: Downloaded newer image' }].map(l => JSON.stringify(l) + '\n');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const text = lines.join('');
    res.write(text.slice(0, 20));              // mid-line
    setTimeout(() => { res.write(text.slice(20, 90)); setTimeout(() => res.end(text.slice(90)), 20); }, 20);
  });
  await new Promise(r => server.listen(sock, r));
  const seen = [];
  const reply = await dockerApi.request('POST', '/images/create?fromImage=x', { socket: sock, onLine: l => seen.push(l) });
  assert.equal(reply.status, 200);
  assert.deepEqual(seen.map(l => l.status), ['Downloading', 'Downloading', 'Status: Downloaded newer image']);
  assert.equal(seen[1].progressDetail.current, 2);
  assert.equal(reply.body.length, 3, 'the resolved body is unchanged');
  const throwing = await dockerApi.request('POST', '/images/create?fromImage=x', { socket: sock, onLine: () => { throw new Error('listener bug'); } });
  assert.equal(throwing.body.length, 3, 'a failing listener does not break the pull');
  await new Promise(r => server.close(r));
  console.log('ok - the Docker client passes progress lines on as they arrive');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
