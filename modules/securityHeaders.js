'use strict';
/**
 * Security response headers, including a Content-Security-Policy that is the
 * backstop for XSS: even if a user-controlled string ever reached the page
 * unescaped, the CSP blocks it from running as script.
 *
 * The app ships a few inline <script> blocks in its own HTML (static, our
 * own code). Rather than allow 'unsafe-inline' (which would also let an
 * injected inline handler run), we hash those blocks at startup and allow
 * exactly them: `script-src 'self' 'sha256-…'`. An injected <script> or an
 * onerror= handler has no matching hash, so it is refused. Hashes are stable
 * because the inline content never changes per request (only <link preload>
 * tags and external src= are rewritten, not inline bodies).
 *
 * style-src keeps 'unsafe-inline' — the UI uses inline style attributes
 * throughout, and CSS injection is not script execution. img/frame/connect
 * are scoped to what the dashboard genuinely needs (user logos/backgrounds,
 * the iframe card, same-origin WebSocket).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
// Inline <script> blocks WITHOUT a src attribute, across every served page.
const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

function collectInlineScriptHashes(dirs = ['public', 'private/pages']) {
  const hashes = new Set();
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.html')); } catch (_) { continue; }
    for (const f of files) {
      let html;
      try { html = fs.readFileSync(path.join(ROOT, dir, f), 'utf8'); } catch (_) { continue; }
      for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
        const digest = crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
        hashes.add(`'sha256-${digest}'`);
      }
    }
  }
  return [...hashes];
}

function buildCsp(scriptHashes) {
  // All scripts are same-origin (Chart.js is self-hosted under /vendor), so no
  // external script origin is needed; an injected inline script or onerror=
  // handler has no matching hash and is refused.
  const scriptSrc = ["'self'", ...scriptHashes].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // User-set logo/background/favicon can be any http(s) URL or a data: URI.
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    // Same-origin XHR + WebSocket (ws/wss to self is covered by 'self').
    "connect-src 'self'",
    // The iframe card embeds a user-chosen URL (it is sandboxed in the card).
    "frame-src 'self' https: http:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

let CSP = null;
function middleware() {
  if (CSP === null) CSP = buildCsp(collectInlineScriptHashes());
  return function securityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  };
}

module.exports = { middleware, collectInlineScriptHashes, buildCsp };
