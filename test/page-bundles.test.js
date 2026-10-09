'use strict';
const checks = require('./_checks');
/**
 * One-file page bundles (modules/pageBundles.js, served by modules/pagePreload.js):
 * - each module page is bundled at start-up and served pointing at its bundle,
 *   whose URL carries a hash and is cached for a year;
 * - signed-in pages' bundles are under /private/bundles/ and refused signed out;
 * - until a bundle is ready, and with EPILYKOS_BUNDLE=0, pages load unbundled;
 * - editing a file the bundle includes gives a new bundle on a later load.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');

const ROOT = path.join(__dirname, '..');
const pageBundles = require('../modules/pageBundles');
const { sendPage, pageWithBundles } = require('../modules/pagePreload');
const { mountPrivatePages } = require('../routes/privatePages');

const ENTRIES = ['/js/main.js', '/js/editor.js', '/private/js/controls.js', '/private/js/showcase.js'];
const wait = ms => new Promise(r => setTimeout(r, ms));

function request(server, p, cookie) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers: cookie ? { Cookie: cookie } : {} }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

(async () => {
  // Before any build, a page is served unbundled (with its module preloads).
  const index = path.join(ROOT, 'public/index.html');
  assert.strictEqual(pageWithBundles(index, '/'), null, 'no bundle yet: unbundled');

  await pageBundles.prebuild(ENTRIES);
  const urls = {};
  for (const e of ENTRIES) {
    urls[e] = pageBundles.bundleUrlFor(e);
    assert.match(urls[e] || '', e.startsWith('/private/') ? /^\/private\/bundles\/[a-z]+\.[0-9a-f]{12}\.js$/ : /^\/bundles\/[a-z]+\.[0-9a-f]{12}\.js$/, `${e} bundled`);
  }
  const html = pageWithBundles(index, '/');
  assert.ok(html.includes(`<script type="module" src="${urls['/js/main.js']}">`), 'page points at its bundle');
  assert.ok(!html.includes('modulepreload'), 'no preloads needed');

  const app = express();
  app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
  app.get('/test-login', (req, res) => { req.session.authenticated = true; res.send('ok'); });
  mountPrivatePages(app);
  app.get('/', (req, res) => sendPage(res, index, '/'));
  app.get('/bundles/:file', (req, res, next) => { if (!pageBundles.serveBundle(req, res, req.path)) next(); });
  app.use((req, res) => res.status(404).send('nope'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const page = await request(server, '/');
    assert.ok(page.body.includes(urls['/js/main.js']));
    const js = await request(server, urls['/js/main.js']);
    assert.strictEqual(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.match(js.headers['cache-control'], /max-age=31536000, immutable/);
    assert.ok(js.body.length > 50000 && js.body.includes('sourceMappingURL='), 'whole bundle with a source map link');
    assert.strictEqual((await request(server, urls['/js/main.js'] + '.map')).status, 200);
    assert.strictEqual((await request(server, '/bundles/main.000000000000.js')).status, 404, 'unknown hash: not found');

    // Signed-in pages' bundles: refused signed out, served signed in.
    const priv = urls['/private/js/controls.js'];
    const out = await request(server, priv);
    assert.ok(out.status === 302 || out.status === 401, `signed out: ${out.status}`);
    assert.ok(!out.body.includes('function'), 'no code signed out');
    const login = await request(server, '/test-login');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const inside = await request(server, priv, cookie);
    assert.strictEqual(inside.status, 200);
    assert.match(inside.headers['cache-control'], /no-store/, 'signed-in bundles are not stored');
    const ctl = await request(server, '/controls', cookie);
    assert.ok(ctl.body.includes(`src="${priv}"`), 'Controls page points at its bundle');

    // Editing an included file: the next check after a moment rebuilds.
    const touched = path.join(ROOT, 'public/js/theme.js');
    const st = fs.statSync(touched);
    fs.utimesSync(touched, st.atime, new Date(st.mtimeMs + 5000));
    try {
      await wait(2100);
      assert.strictEqual(pageBundles.bundleUrlFor('/js/main.js'), null, 'stale bundle not served while rebuilding');
      for (let i = 0; i < 100 && !pageBundles.bundleUrlFor('/js/main.js'); i++) await wait(50);
      assert.ok(pageBundles.bundleUrlFor('/js/main.js'), 'rebuilt');
    } finally { fs.utimesSync(touched, st.atime, st.mtime); }

    // Turned off: unbundled.
    process.env.EPILYKOS_BUNDLE = '0';
    assert.strictEqual(pageWithBundles(index, '/'), null);
    const plain = await request(server, '/');
    assert.ok(plain.body.includes('src="js/main.js"') && plain.body.includes('modulepreload'), 'unbundled with preloads');
    delete process.env.EPILYKOS_BUNDLE;
  } finally { server.close(); }
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
