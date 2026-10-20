'use strict';
const crypto = require('node:crypto');

function validCsrfToken(expected, supplied) {
  return typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) &&
    typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

// A synchronizer token belongs to this session, including before sign-in.
// Read it through a same-origin, non-cacheable request; never put it in URLs.
function csrfToken(req, res) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.set('Cache-Control', 'no-store').json({ token: req.session.csrfToken });
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // These handlers authenticate with their own webhook secret, not a session.
  const pathname = req.originalUrl.split('?')[0];
  if (/^\/api\/pvoutput\/webhook(?:\/[^/]+)?\/?$/.test(pathname)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ error: 'CSRF protection: Origin mismatch' });
      }
    } catch (_) { return res.status(403).json({ error: 'CSRF protection: Invalid Origin header' }); }
  }
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'CSRF protection: Missing X-Requested-With header' });
  }
  const supplied = req.headers['x-csrf-token'];
  if (!validCsrfToken(req.session.csrfToken, supplied)) {
    return res.set('X-CSRF-Error', 'token').status(403).json({ error: 'CSRF protection: Invalid session token. Refresh and try again.' });
  }
  next();
}

module.exports = { csrfProtection, csrfToken };
