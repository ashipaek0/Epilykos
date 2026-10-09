/**
 * Signed-in pages: the card showcase (/showcase) and device controls
 * (/controls), and their files (/private/js/*, /private/css/*).
 *
 * Their files live in private/, outside public/, so the public static server
 * can never hand them out. Every request under these paths, whatever its
 * method or sub path, needs a signed-in session: without one a page request
 * goes to the sign-in page and anything else gets 401, so an outsider learns
 * nothing from guessing paths. Signed in, an unknown sub path is a plain 404.
 * Nothing here is cached by the browser or a proxy.
 *
 * @module routes/privatePages
 */
const path = require('path');
const { sendPage } = require('../modules/pagePreload');
const { serveBundle } = require('../modules/pageBundles');

const PRIVATE_DIR = path.join(__dirname, '..', 'private');
const PAGES = { '/showcase': 'showcase.html', '/controls': 'controls.html' };
/** Path prefixes this module owns (the SPA catch-all must leave them alone). */
const PREFIXES = ['/showcase', '/controls', '/private'];

function owns(rawPath) {
  const p = String(rawPath).toLowerCase();   // /SHOWCASE is treated like /showcase
  return PREFIXES.some(prefix => p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '.'));
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function notFound(res) {
  res.status(404).type('text/plain').send('Not found');
}

/**
 * @param {import('express').Express} app
 */
function mountPrivatePages(app) {
  app.use((req, res, next) => {
    if (!owns(req.path)) return next();
    noStore(res);
    if (!(req.session && req.session.authenticated)) {
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect('/login');
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    const page = PAGES[req.path];
    if (page) return sendPage(res, path.join(PRIVATE_DIR, 'pages', page), req.path);
    if (req.path.startsWith('/private/bundles/') && serveBundle(req, res, req.path)) return;
    const asset = /^\/private\/(js|css)\/([a-z0-9-]+\.(js|css))$/.exec(req.path);
    if (asset && (asset[1] === 'js') === (asset[3] === 'js')) {
      return res.sendFile(path.join(PRIVATE_DIR, asset[1], asset[2]), { dotfiles: 'deny' }, err => {
        if (err && !res.headersSent) notFound(res);
      });
    }
    notFound(res);
  });
}

module.exports = { mountPrivatePages, ownsPrivatePath: owns, PRIVATE_DIR };
