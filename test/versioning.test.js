'use strict';
const checks = require('./_checks');
// Versions come from git tags (.github/scripts/version.js): each merge to
// main that changes code is the next patch (1.0.0, 1.0.1 …), a release made
// by hand on GitHub (v2.0.0) sets a new starting point, dev builds are the
// next patch as a pre-release, and docs-only changes or the weekly rebuild
// keep the version.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const script = path.join(__dirname, '..', '.github', 'scripts', 'version.js');
const { decide, latestTag } = require(script);

assert.equal(latestTag(['v1.0.9', 'v1.0.10', 'v1.0.2', 'app-dev', 'v1.0']), 'v1.0.10', 'version order, not text order');
assert.equal(latestTag(['v2.0.0', 'v1.0.10']), 'v2.0.0');
assert.equal(latestTag([]), null);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-version-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const run = (...a) => JSON.parse(execFileSync('node', [script, ...a], { cwd: repo, encoding: 'utf8' }));
const commit = (file, msg) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.appendFileSync(path.join(repo, file), msg + '\n'); git('add', '-A'); git('commit', '-qm', msg); };
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');

commit('server.js', 'first');
assert.deepEqual(run('main'), { version: '1.0.0', tag: 'v1.0.0', isNew: true, previous: null }, 'the first release is 1.0.0');
assert.match(run('dev').version, /^1\.0\.0-dev\+[0-9a-f]{7}$/);
git('tag', 'v1.0.0');
assert.deepEqual(run('main'), { version: '1.0.0', tag: 'v1.0.0', isNew: false, previous: 'v1.0.0' }, 'the weekly rebuild of a tagged commit keeps its version');

commit('README.md', 'docs');
commit('docs/x.md', 'more docs');
commit('.github/workflows/x.yml', 'ci');
assert.equal(run('main').isNew, false, 'docs and workflow changes are not a new version');
assert.equal(run('main').version, '1.0.0');

commit('server.js', 'fix');
assert.deepEqual(run('main'), { version: '1.0.1', tag: 'v1.0.1', isNew: true, previous: 'v1.0.0' }, 'a code change is the next patch');
assert.match(run('dev').version, /^1\.0\.1-dev\+/, 'dev shows the release it leads to');
git('tag', 'v1.0.1');

commit('server.js', 'big');
assert.deepEqual(run('release', 'v2.0.0'), { version: '2.0.0', tag: 'v2.0.0', isNew: false, previous: 'v1.0.1' }, 'a release you create sets the version');
git('tag', 'v2.0.0');
assert.equal(run('main').version, '2.0.0', 'the merge build of that same commit keeps 2.0.0');
commit('modules/a.js', 'next');
assert.equal(run('main').version, '2.0.1', 'and the next merge counts on from it');

assert.throws(() => decide('release', 'v2.0', { tags: () => [] }), /must look like v2\.0\.0/);
assert.throws(() => decide('release', '1.2.3', { tags: () => [] }), /must look like/);
console.log('ok - main merges are 1.0.0, 1.0.1 …; docs, workflows and the weekly rebuild keep the version; a GitHub release sets it; dev builds lead to the next');

// The image and the app carry it.
const root = path.join(__dirname, '..');
assert.match(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), /ENV EPILYKOS_VERSION=\$\{EPILYKOS_VERSION\}/);
const main = fs.readFileSync(path.join(root, '.github', 'workflows', 'docker-build.yml'), 'utf8');
assert.match(main, /release:\n\s+types: \[published\]/, 'a release created on GitHub builds');
assert.match(main, /irunmole\/epilykos:\$\{\{ steps\.version\.outputs\.version \}\}/, 'the image is also tagged with its version');
assert.match(main, /gh release create "\$TAG".*--generate-notes/s, 'each new version gets a GitHub Release');
assert.match(main, /concurrency:\n\s+group: docker-build-main/, 'one main build at a time');
process.env.EPILYKOS_VERSION = '1.0.7';
delete require.cache[require.resolve('../modules/version')];
assert.equal(require('../modules/version').appVersion(), '1.0.7');
delete process.env.EPILYKOS_VERSION;
assert.equal(require('../modules/version').appVersion(), require('../package.json').version, 'local builds fall back to package.json');
console.log('ok - the image is built and tagged with its version, and the app reports it');
checks.done();
