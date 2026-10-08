'use strict';
const checks = require('./_checks');
/**
 * Signed-in pages (routes/privatePages.js): the showcase and controls pages
 * and their files are only ever served to a signed-in session. Signed out,
 * every path under them (pages, files, guessed or encoded sub paths, any
 * method) goes to the sign-in page or gets 401, never the content. Raw
 * request paths are sent as typed, so no client-side normalising hides a case.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { mountPrivatePages, ownsPrivatePath } = require('../routes/privatePages');

const ROOT = path.join(__dirname, '..');
const app = express();
app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
app.get('/test-login', (req, res) => { req.session.authenticated = true; res.send('ok'); });
mountPrivatePages(app);
app.use(express.static(path.join(ROOT, 'public')));
app.use((req, res) => res.status(200).send('SPA'));

function request(server, method, rawPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: rawPath, headers: cookie ? { Cookie: cookie } : {} }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECRET_MARKERS = ['Card showcase', 'showcase-data', 'SHOWCASE_BLOCKS', '<title>Controls', 'pv-note', '.sc-frame'];
const SIGNED_OUT_PATHS = [
  '/showcase', '/controls', '/showcase/', '/controls/', '/showcase/anything', '/controls/x/y', '/showcase.html', '/controls.html',
  '/private', '/private/', '/private/js/showcase.js', '/private/js/showcase-data.js', '/private/js/showcase-api.js', '/private/js/showcase-layout.js', '/private/js/controls.js',
  '/private/css/private.css', '/private/pages/showcase.html', '/private/pages/controls.html', '/private/js/../pages/showcase.html',
  '/private/js/%2e%2e/pages/showcase.html', '/private/js/..%2fpages%2fshowcase.html', '/private/js/', '/private/js/missing.js',
  '/showcase?x=1', '/private/js/showcase.js?v=1', '/SHOWCASE', '/Controls', '/PRIVATE/js/showcase.js'
];

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    // ── Signed out ──
    for (const p of SIGNED_OUT_PATHS) {
      for (const method of ['GET', 'HEAD']) {
        const r = await request(server, method, p);
        assert.strictEqual(r.status, 302, `${method} ${p} signed out → redirect (got ${r.status})`);
        assert.strictEqual(r.headers.location, '/login', `${method} ${p} → /login`);
        assert.match(r.headers['cache-control'] || '', /no-store/, `${method} ${p} not cached`);
        for (const m of SECRET_MARKERS) assert.ok(!r.body.includes(m), `${method} ${p} leaks "${m}"`);
      }
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await request(server, method, p);
        assert.strictEqual(r.status, 401, `${method} ${p} signed out → 401 (got ${r.status})`);
        for (const m of SECRET_MARKERS) assert.ok(!r.body.includes(m), `${method} ${p} leaks "${m}"`);
      }
    }
    // The public file server has no copy of anything private.
    for (const p of ['/js/showcase.js', '/js/showcase-data.js', '/showcase.css', '/pages/showcase.html', '/css/private.css']) {
      const r = await request(server, 'GET', p);
      for (const m of SECRET_MARKERS) assert.ok(!r.body.includes(m), `public ${p} leaks "${m}"`);
    }

    // ── Signed in ──
    const login = await request(server, 'GET', '/test-login');
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const page = await request(server, 'GET', '/showcase', cookie);
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<title>Card showcase/);
    assert.match(page.headers['cache-control'] || '', /no-store/);
    assert.match(page.headers['x-robots-tag'] || '', /noindex/);
    assert.strictEqual((await request(server, 'GET', '/controls', cookie)).status, 200);
    for (const f of ['showcase.js', 'showcase-data.js', 'showcase-api.js', 'showcase-layout.js', 'controls.js']) {
      const r = await request(server, 'GET', '/private/js/' + f, cookie);
      assert.strictEqual(r.status, 200, f);
      assert.match(r.headers['content-type'] || '', /javascript/, f + ' type');
    }
    const css = await request(server, 'GET', '/private/css/private.css', cookie);
    assert.strictEqual(css.status, 200);
    assert.match(css.headers['content-type'] || '', /css/);
    // Pages only by their own address; nothing else under the prefixes, and no other methods.
    for (const p of ['/private/pages/showcase.html', '/private/js/missing.js', '/private/css/showcase.js', '/private/js/private.css',
      '/showcase/anything', '/controls/', '/showcase.html', '/private/js/../pages/showcase.html', '/private/js/%2e%2e/pages/showcase.html',
      '/private/js/Showcase.js', '/private/', '/private/js/.hidden.js']) {
      const r = await request(server, 'GET', p, cookie);
      assert.strictEqual(r.status, 404, `signed in ${p} → 404 (got ${r.status})`);
      assert.ok(!r.body.includes('SHOWCASE_BLOCKS'), p);
    }
    assert.strictEqual((await request(server, 'POST', '/showcase', cookie)).status, 404);

    // ── Wiring in server.js and the offline cache ──
    assert.ok(ownsPrivatePath('/showcase') && ownsPrivatePath('/private/js/x.js') && ownsPrivatePath('/controls.html') && !ownsPrivatePath('/showcases') && !ownsPrivatePath('/'));
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const mountAt = serverSrc.indexOf('mountPrivatePages(app)'), staticAt = serverSrc.indexOf("app.use(express.static(path.join(__dirname, 'public')");
    assert.ok(mountAt > 0 && mountAt < staticAt, 'private pages are mounted before the public file server');
    assert.ok(serverSrc.indexOf('app.use(session(') < mountAt, 'sessions are set up before the private pages');
    assert.match(serverSrc, /if \(ownsPrivatePath\(req\.path\) \|\|/, 'the SPA catch-all leaves private paths alone');
    assert.ok(!fs.existsSync(path.join(ROOT, 'public', 'showcase.html')) && !fs.existsSync(path.join(ROOT, 'public', 'controls.html')));
    const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
    const PRIVATE_PATH = new Function(sw.match(/const PRIVATE_PATH = (\/.*\/);/)[0] + ' return PRIVATE_PATH;')();
    for (const p of ['/showcase', '/controls', '/private/js/showcase.js', '/settings', '/settings.html', '/editor']) assert.ok(PRIVATE_PATH.test(p), `service worker skips ${p}`);
    for (const p of ['/', '/style.css', '/js/editor.js', '/editor.css', '/js/settings-shell.js']) assert.ok(!PRIVATE_PATH.test(p), `service worker still caches ${p}`);
    assert.match(sw, /no-store/, 'service worker skips no-store responses');
  } finally {
    server.close();
  }
  console.log('private pages: all checks passed');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
