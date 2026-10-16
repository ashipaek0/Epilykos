#!/usr/bin/env node
'use strict';
/**
 * Which version a build is. Git tags hold the version (vMAJOR.MINOR.PATCH);
 * package.json does not. Run from a checkout with tags and history
 * (fetch-depth: 0).
 *
 *   version.js main              merge to main or the weekly rebuild
 *   version.js dev               dev builds
 *   version.js release v2.0.0    a release created by hand on GitHub
 *
 * Prints JSON { version, tag, isNew, previous }:
 *   main     the newest tag when this commit is it, or nothing but docs and
 *            workflows changed since (weekly rebuild, README edit): same
 *            version, isNew false. Otherwise the next patch, isNew true: CI
 *            tags it and makes the GitHub Release once the image is pushed.
 *            The first one is 1.0.0.
 *   dev      next patch as a pre-release: 1.0.3-dev+abc1234
 *   release  the tag you typed; the next merge to main counts on from it
 */
const { execFileSync } = require('child_process');

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
// Changes that never alter the image: no new version for them.
const NOT_CODE = [':(exclude)*.md', ':(exclude)docs', ':(exclude).github'];

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

function parse(tag) {
  const m = TAG_RE.exec(tag);
  return m ? m.slice(1).map(Number) : null;
}

/** Newest version tag, by version order (not date). */
function latestTag(tags) {
  return tags.filter(t => parse(t))
    .sort((a, b) => { const x = parse(a), y = parse(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })
    .pop() || null;
}

const bump = tag => { const [a, b, c] = parse(tag); return `${a}.${b}.${c + 1}`; };

function decide(mode, arg, repo) {
  const latest = latestTag(repo.tags());
  if (mode === 'release') {
    if (!parse(arg || '')) throw new Error(`release tag must look like v2.0.0, not "${arg}"`);
    return { version: arg.slice(1), tag: arg, isNew: false, previous: latest };
  }
  if (mode === 'dev') {
    const next = latest ? bump(latest) : '1.0.0';
    return { version: `${next}-dev+${repo.head().slice(0, 7)}`, tag: null, isNew: false, previous: latest };
  }
  if (mode === 'main') {
    if (!latest) return { version: '1.0.0', tag: 'v1.0.0', isNew: true, previous: null };
    if (repo.tagCommit(latest) === repo.head() || !repo.codeChangedSince(latest)) {
      return { version: latest.slice(1), tag: latest, isNew: false, previous: latest };
    }
    const next = bump(latest);
    return { version: next, tag: `v${next}`, isNew: true, previous: latest };
  }
  throw new Error('usage: version.js main | dev | release <tag>');
}

const gitRepo = {
  tags: () => git('tag', '--list', 'v*').split('\n').filter(Boolean),
  head: () => git('rev-parse', 'HEAD'),
  tagCommit: t => git('rev-list', '-n', '1', t),
  codeChangedSince: t => {
    try { execFileSync('git', ['diff', '--quiet', t, 'HEAD', '--', '.', ...NOT_CODE]); return false; } catch (_) { return true; }
  },
};

if (require.main === module) {
  try {
    console.log(JSON.stringify(decide(process.argv[2], process.argv[3], gitRepo)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

module.exports = { decide, latestTag, parse };
