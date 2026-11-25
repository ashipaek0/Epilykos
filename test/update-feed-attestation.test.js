'use strict';
const checks = require('./_checks');
/**
 * Build attestations: the update feed copies the attestation reference from the build's digest record (only when it is whole), and both
 * build workflows make the attestation with the permissions it needs, sign the digest that was just pushed, and put the reference in the
 * record that the feed and EpilykosOS read.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const repo = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-feed-'));

function runFeed(record, existing) {
  const recordFile = path.join(tmp, 'record.json'), feedFile = path.join(tmp, 'feed.json');
  fs.writeFileSync(recordFile, JSON.stringify(record));
  if (existing) fs.writeFileSync(feedFile, JSON.stringify(existing)); else fs.rmSync(feedFile, { force: true });
  execFileSync(process.execPath, [path.join(repo, '.github/scripts/update-feed.js'), 'latest', recordFile, feedFile], { cwd: repo, encoding: 'utf8' });
  return JSON.parse(fs.readFileSync(feedFile, 'utf8'));
}
const record = (extra = {}) => ({ service: 'epilykos', image: 'irunmole/epilykos', digest: 'sha256:' + 'a'.repeat(64), tag: 'irunmole/epilykos:latest', commit: 'c0ffee', ref: 'main', version: '1.4.0', build_id: '10.1', built_at: '2026-11-25T00:00:00Z', ...extra });
const attestation = { id: '4242', url: 'https://github.com/ashipaek0/Epilykos/attestations/4242', repository: 'ashipaek0/Epilykos', signer_workflow: 'ashipaek0/Epilykos/.github/workflows/docker-build.yml@refs/heads/main', subject: 'irunmole/epilykos@sha256:' + 'a'.repeat(64) };

// ── The feed ──
let feed = runFeed(record({ attestation }));
assert.deepStrictEqual(feed.latest.attestation, attestation, 'the reference is in the feed entry');
assert.deepStrictEqual(feed.history[0].attestation, attestation, 'and in the history');
assert.strictEqual(feed.latest.digest, 'sha256:' + 'a'.repeat(64), 'the entry is otherwise as before');

feed = runFeed(record());
assert.ok(!('attestation' in feed.latest), 'a build without one has none: it must read as unverified');

for (const bad of [{ ...attestation, id: '' }, { ...attestation, url: 5 }, { ...attestation, signer_workflow: undefined }, { ...attestation, subject: 'x'.repeat(301) }, 'text', [], null]) {
  assert.ok(!('attestation' in runFeed(record({ attestation: bad })).latest), 'a partial or malformed one is dropped, never half-copied: ' + JSON.stringify(bad).slice(0, 60));
}
const extra = runFeed(record({ build_id: '11.1', attestation: { ...attestation, evil: 'x', id: '9' } }), runFeed(record({ attestation })));
assert.deepStrictEqual(Object.keys(extra.latest.attestation).sort(), ['id', 'repository', 'signer_workflow', 'subject', 'url'], 'only the known parts are copied');
assert.strictEqual(extra.history.length, 2, 'earlier entries are kept');
console.log('ok - the update feed copies a whole attestation reference and nothing else');

// ── The app passes the entry through ──
const updates = require('../modules/updates');
const mine = { buildId: '1.1', builtAt: '2026-11-01T00:00:00Z', version: '1.3.0', commit: 'old' };
const status = updates.compare(mine, runFeed(record({ attestation })));
assert.strictEqual(status.state, 'available'); assert.deepStrictEqual(status.latest.attestation, attestation, 'the saved update status carries it');
console.log('ok - the saved update status carries the reference');

// ── The workflows ──
let yaml = null; try { yaml = require('js-yaml'); } catch (_) { /* not a dependency: the checks below read the text */ }
for (const file of ['docker-build.yml', 'docker-build-dev.yml']) {
  const text = fs.readFileSync(path.join(repo, '.github/workflows', file), 'utf8');
  const job = text.slice(text.indexOf('  build-and-push:'), text.indexOf('\n  publish-update-feed:'));
  assert.match(job, /permissions:\n      contents: read\n      id-token: write\n      attestations: write/, `${file}: the build job may ask for a signing identity and store the attestation`);
  assert.match(job, /uses: actions\/attest-build-provenance@v\d+/, `${file}: it attests`);
  assert.match(job, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/, `${file}: the digest that was just pushed`);
  assert.match(job, /subject-name: \$\{\{ steps\.subject\.outputs\.name \}\}/);
  assert.match(job, /name=index\.docker\.io\/\$\{IMAGE_TAG%:\*\}/, `${file}: the Docker Hub name, without the tag`);
  assert.match(job, /push-to-registry: true/, `${file}: the attestation goes to the registry beside the image`);
  assert.match(job, /id: attest\n        continue-on-error: true/, `${file}: a signing outage does not stop a release`);
  assert.ok(job.indexOf('id: build') < job.indexOf('id: attest') && job.indexOf('id: attest') < job.indexOf('name: Record image digest'), `${file}: build, then attest, then record`);
  assert.match(job, /ATTESTATION_ID: \$\{\{ steps\.attest\.outputs\.attestation-id \}\}/, `${file}: the record reads the attestation outputs`);
  assert.match(job, /ATTESTATION_URL: \$\{\{ steps\.attest\.outputs\.attestation-url \}\}/);
  assert.match(job, /WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/);
  assert.match(job, /signer_workflow: \$workflow/, `${file}: the record names who must have signed it`);
  assert.ok(!/permissions:[\s\S]*id-token: write[\s\S]*publish-update-feed/.test(text.slice(text.indexOf('  publish-update-feed:'))), `${file}: no other job gets the signing permission`);
  if (yaml) assert.ok(yaml.load(text).jobs['build-and-push'].permissions['id-token'] === 'write');
}
const docs = fs.readFileSync(path.join(repo, 'docs/build-attestations.md'), 'utf8');
assert.match(docs, /gh attestation verify oci:\/\/docker\.io\/irunmole\/epilykos@sha256:<digest> --repo ashipaek0\/Epilykos/);
console.log('ok - both build workflows attest the pushed digest and record the reference');
fs.rmSync(tmp, { recursive: true, force: true });
checks.done();
