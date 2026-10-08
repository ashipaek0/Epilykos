'use strict';
/**
 * Pages whose script is an ES module (dashboard, editor, Controls, showcase)
 * import 70+ files up to 8 levels deep. A browser only finds each level once
 * the one before has arrived, so on a remote link a page waited 8+ round trips
 * before its cards could draw. Serving the page with a
 * <link rel="modulepreload"> for every file its module imports lets the
 * browser fetch them all at once.
 *
 * The import list is worked out from the files themselves (static imports and
 * literal dynamic imports), cached briefly, so it follows code changes
 * without a build step. A wrong or missing entry only costs a wasted or
 * missed prefetch: the imports themselves still decide what runs.
 *
 * @module pagePreload
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_MS = 30 * 1000;
const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const SCRIPT_RE = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const cache = new Map();   // html file -> { at, mtimeMs, html }

/** Site URL path -> file on disk (public/ or private/), or null. */
function fileForUrl(urlPath) {
  const clean = path.posix.normalize(urlPath);
  if (clean.includes('\0') || clean.includes('..')) return null;
  const file = clean.startsWith('/private/') ? path.join(ROOT, clean) : path.join(ROOT, 'public', clean);
  return file.startsWith(ROOT + path.sep) ? file : null;
}

/** Every module URL reachable from `entryUrl`, in discovery order. */
function moduleGraph(entryUrl) {
  const seen = new Set();
  const queue = [entryUrl];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    const file = fileForUrl(url.split('?')[0]);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    seen.add(url);
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || !(spec.startsWith('.') || spec.startsWith('/'))) continue;
      const u = new URL(spec, 'http://page' + url);
      const next = u.pathname + u.search;
      if (!seen.has(next)) queue.push(next);
    }
  }
  return [...seen];
}

/** The page's HTML with modulepreload links for its module scripts. */
function pageWithPreloads(htmlFile, pageUrl = '/') {
  const mtimeMs = fs.statSync(htmlFile).mtimeMs;
  const hit = cache.get(htmlFile);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < CACHE_MS) return hit.html;
  let html = fs.readFileSync(htmlFile, 'utf8');
  const urls = new Set();
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (/^[a-z]+:\/\//i.test(m[1])) continue;
    const entry = new URL(m[1], 'http://page' + pageUrl);
    for (const u of moduleGraph(entry.pathname + entry.search)) urls.add(u);
  }
  if (urls.size && html.includes('</head>')) {
    const links = [...urls].map(u => `<link rel="modulepreload" href="${u.replace(/"/g, '&quot;')}">`).join('\n');
    html = html.replace('</head>', links + '\n</head>');
  }
  cache.set(htmlFile, { at: Date.now(), mtimeMs, html });
  return html;
}

/** Send a page (Cache-Control no-cache, as express.static gives pages). */
function sendPage(res, htmlFile, pageUrl = '/') {
  let html;
  try { html = pageWithPreloads(htmlFile, pageUrl); }
  catch (_) { return res.sendFile(htmlFile); }
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

module.exports = { sendPage, pageWithPreloads, moduleGraph };
