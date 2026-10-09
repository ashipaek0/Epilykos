'use strict';
/**
 * One file per page instead of 70+. The dashboard, editor, Controls and
 * showcase pages are ES modules that import 67-73 files. A browser fetches at
 * most six at a time over HTTP/1.1, and each needs a round trip even when
 * cached (pages revalidate), so over a remote link a page took seconds to draw.
 *
 * At start-up the server bundles each page's module (esbuild, in memory, a
 * few hundred ms) and serves the page pointing at the bundle. The bundle's URL
 * carries a hash of its contents, so browsers may keep it for a year and a
 * changed file always gets a new URL. Nothing is written to disk and there is
 * no build command: editing a file is picked up on the next page load.
 *
 * While a bundle is building, or if bundling fails, or with
 * EPILYKOS_BUNDLE=0, pages are served unbundled as before (pagePreload.js),
 * so a bundling problem can never stop a page from working.
 *
 * Bundles of signed-in pages are served under /private/bundles/, which only a
 * signed-in session can reach (routes/privatePages.js).
 *
 * @module pageBundles
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

const ROOT = path.join(__dirname, '..');
const CHECK_MS = 2000;            // how often a page load re-checks inputs for edits
const OLD_BUNDLE_GRACE_MS = 10 * 60 * 1000;   // how long a replaced bundle stays servable
const enabled = () => process.env.EPILYKOS_BUNDLE !== '0';

let esbuild = null;
function loadEsbuild() {
  if (esbuild === null) {
    try { esbuild = require('esbuild'); } catch (e) { esbuild = false; logger.warn('[bundles] esbuild unavailable, pages load unbundled:', e.message); }
  }
  return esbuild || null;
}

/** Site URL path -> file on disk (public/ or private/). */
function fileForUrl(urlPath) {
  const clean = path.posix.normalize(urlPath.split('?')[0]);
  if (clean.includes('..')) return null;
  return clean.startsWith('/private/') ? path.join(ROOT, clean) : path.join(ROOT, 'public', clean);
}

// Imports written as site paths ('/js/x.js', '/private/js/x.js') map to files.
const sitePaths = {
  name: 'site-paths',
  setup(build) {
    build.onResolve({ filter: /^\// }, args => {
      if (args.kind === 'entry-point') return undefined;   // already a file path
      if (args.path.startsWith('//')) return { external: true };
      const file = fileForUrl(args.path);
      return file ? { path: file } : { errors: [{ text: `Can't resolve ${args.path}` }] };
    });
  }
};

const bundles = new Map();   // entry URL -> { state, url, code, map, inputs, checkedAt, building }
const byUrl = new Map();     // bundle URL (and .map) -> { body, type }

function bundleDir(entryUrl) { return entryUrl.startsWith('/private/') ? '/private/bundles/' : '/bundles/'; }

function inputsChanged(entry) {
  for (const [file, mtimeMs] of entry.inputs) {
    try { if (fs.statSync(file).mtimeMs !== mtimeMs) return true; } catch (_) { return true; }
  }
  return false;
}

async function build(entryUrl) {
  const eb = loadEsbuild();
  if (!eb) return;
  const current = bundles.get(entryUrl) || {};
  if (current.building) return current.building;
  const started = Date.now();
  const job = (async () => {
    const name = path.basename(entryUrl.split('?')[0], '.js');
    const result = await eb.build({
      entryPoints: [fileForUrl(entryUrl)], bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
      write: false, minify: true, keepNames: true, sourcemap: 'external', metafile: true,
      outfile: path.join(ROOT, '.bundles', name + '.js'), absWorkingDir: ROOT,
      plugins: [sitePaths], logLevel: 'silent', legalComments: 'none'
    });
    const jsOut = result.outputFiles.find(f => f.path.endsWith('.js'));
    const mapOut = result.outputFiles.find(f => f.path.endsWith('.map'));
    const hash = crypto.createHash('sha256').update(jsOut.contents).digest('hex').slice(0, 12);
    const url = `${bundleDir(entryUrl)}${name}.${hash}.js`;
    const code = Buffer.concat([Buffer.from(jsOut.contents), Buffer.from(`\n//# sourceMappingURL=${path.posix.basename(url)}.map\n`)]);
    const inputs = new Map();
    for (const rel of Object.keys(result.metafile.inputs)) {
      const file = path.resolve(ROOT, rel);
      inputs.set(file, fs.statSync(file).mtimeMs);
    }
    const old = bundles.get(entryUrl);
    if (old && old.url && old.url !== url) {
      // A page served just before the rebuild still points at the old bundle:
      // keep it for a while so that page's script request doesn't 404.
      const stale = old.url;
      setTimeout(() => { byUrl.delete(stale); byUrl.delete(stale + '.map'); }, OLD_BUNDLE_GRACE_MS).unref();
    }
    byUrl.set(url, { body: code, type: 'application/javascript; charset=utf-8' });
    if (mapOut) byUrl.set(url + '.map', { body: Buffer.from(mapOut.contents), type: 'application/json; charset=utf-8' });
    bundles.set(entryUrl, { state: 'ready', url, inputs, checkedAt: Date.now() });
    logger.info(`[bundles] ${entryUrl} -> ${url} (${inputs.size} files, ${Math.round(code.length / 1024)} KB, ${Date.now() - started} ms)`);
  })().catch(e => {
    bundles.set(entryUrl, { state: 'failed', checkedAt: Date.now(), inputs: new Map() });
    const detail = (e.errors || []).map(x => x.text + (x.location ? ` (${x.location.file}:${x.location.line})` : '')).join('; ');
    logger.warn(`[bundles] ${entryUrl} could not be bundled, it loads unbundled: ${detail || e.message}`);
  });
  bundles.set(entryUrl, { ...current, building: job });
  await job;
  const after = bundles.get(entryUrl);
  if (after) delete after.building;
}

/**
 * The bundle URL for a page's module entry, or null when it isn't ready (the
 * page is then served unbundled and a build is started).
 */
function bundleUrlFor(entryUrl) {
  if (!enabled() || !loadEsbuild()) return null;
  const entry = bundles.get(entryUrl);
  if (!entry || (!entry.state && !entry.building)) { build(entryUrl); return null; }
  if (entry.building && !entry.url) return null;
  if (entry.state === 'failed') {
    // Try again after an edit (or a minute), not on every load.
    if (Date.now() - entry.checkedAt > 60000) build(entryUrl);
    return null;
  }
  if (Date.now() - entry.checkedAt > CHECK_MS) {
    entry.checkedAt = Date.now();
    if (inputsChanged(entry)) { entry.state = 'stale'; build(entryUrl); return null; }
  }
  return entry.state === 'ready' ? entry.url : null;
}

/** Serve a bundle or its source map; false when `urlPath` isn't one. */
function serveBundle(req, res, urlPath) {
  const hit = byUrl.get(urlPath);
  if (!hit) return false;
  res.type(hit.type);
  if (!urlPath.startsWith('/private/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(hit.body);
  return true;
}

/** Bundle the given entries now (server start-up), so first visitors get them. */
function prebuild(entryUrls) {
  if (!enabled() || !loadEsbuild()) return Promise.resolve();
  return Promise.all(entryUrls.map(u => build(u)));
}

module.exports = { bundleUrlFor, serveBundle, prebuild, build };
