#!/usr/bin/env node
'use strict';
/**
 * Update feed: after an image build, add it to <channel>.json on the
 * update-feed branch. The app (modules/updates.js) reads that file to tell
 * whether a newer build exists and what changed.
 *
 *   node update-feed.js <channel> <digest-record.json> <feed-file.json>
 *
 * The digest record is the one the build job writes (service, image, digest,
 * tag, commit, ref, version, build_id, built_at). Notes are the commit subjects
 * since the previous build on this channel; a build of the same commit is a
 * rebuild (base image and bundled tools only).
 *
 * Feed file: { channel, latest: <entry>, history: [<entry>, … newest first, 30 kept] }
 * entry:     { buildId, version, commit, digest, image, builtAt, kind: 'release'|'rebuild', notes: [..],
 *               attestation?: { id, url, repository, signer_workflow, subject } }
 *
 * attestation is the build's signed provenance for this digest (made by the build job with actions/attest-build-provenance), present only
 * when the build made one. A check (EpilykosOS, before it installs) verifies it with
 *   gh attestation verify oci://docker.io/<image>@<digest> --repo <repository>
 * and must treat a feed entry without one as unverified. See docs/build-attestations.md.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const [channel, recordPath, feedPath] = process.argv.slice(2);
if (!channel || !recordPath || !feedPath) {
  console.error('usage: update-feed.js <channel> <digest-record.json> <feed-file.json>');
  process.exit(2);
}

const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
let feed = { channel, latest: null, history: [] };
try { feed = JSON.parse(fs.readFileSync(feedPath, 'utf8')); } catch (_) { /* first build on this channel */ }
const previous = feed.latest;

function notesSince(from, to) {
  if (!from || from === to) return [];
  try {
    const out = execFileSync('git', ['log', '--no-merges', '--format=%s', '-n', '30', `${from}..${to}`], { encoding: 'utf8' });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) {
    return [];   // previous commit not in this clone's history (shallow, or rewritten)
  }
}

/** The attestation reference from the record, only if it is whole (every part a short string); else none. */
function attestationOf(record) {
  const a = record && record.attestation;
  if (!a || typeof a !== 'object') return null;
  const out = {};
  for (const key of ['id', 'url', 'repository', 'signer_workflow', 'subject']) {
    if (typeof a[key] !== 'string' || !a[key] || a[key].length > 300) return null;
    out[key] = a[key];
  }
  return out;
}

const sameCommit = previous && previous.commit === record.commit;
const entry = {
  buildId: String(record.build_id),
  version: record.version,
  commit: record.commit,
  digest: record.digest,
  image: `${record.image}:${record.tag ? String(record.tag).split(':').pop() : channel}`,
  builtAt: record.built_at,
  kind: sameCommit ? 'rebuild' : 'release',
  notes: sameCommit ? [] : notesSince(previous && previous.commit, record.commit),
};
const attestation = attestationOf(record);
if (attestation) entry.attestation = attestation;

feed = {
  channel,
  latest: entry,
  history: [entry, ...(feed.history || []).filter(e => e && e.buildId !== entry.buildId)].slice(0, 30),
};
fs.writeFileSync(feedPath, JSON.stringify(feed, null, 2) + '\n');
console.log(`${channel}: ${entry.kind} ${entry.version} build ${entry.buildId} (${entry.notes.length} notes, ${entry.attestation ? 'attested' : 'no attestation'})`);
