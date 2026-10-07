'use strict';
const checks = require('./_checks');
/**
 * test/safe-fetch.test.js — modules/utils.js safeFetch (SSRF guard on every
 * redirect hop) and trimSlashes (linear-time slash trimming). fetch is stubbed;
 * IP-literal URLs keep DNS out of it.
 */
const assert = require('node:assert');
const path = require('path');
const { safeFetch, trimSlashes } = require(path.join(__dirname, '..', 'modules', 'utils'));

const routes = {};
const seen = [];
global.fetch = async (url, init) => {
  seen.push({ url: String(url), redirect: init && init.redirect });
  const r = routes[String(url)] || { status: 200 };
  return { status: r.status, ok: r.status < 300, headers: { get: k => (k === 'location' ? r.location || null : null) } };
};

let failed = 0;
async function test(name, fn) {
  try { seen.length = 0; await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`not ok - ${name}\n  ${e.stack}`); }
}

(async () => {
  await test('plain response, redirects handled manually', async () => {
    const res = await safeFetch('http://192.168.1.10/data', {}, { allowPrivate: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen[0].redirect, 'manual');
  });

  await test('follows a redirect to another allowed host', async () => {
    routes['http://192.168.1.10/a'] = { status: 302, location: 'http://192.168.1.11/b' };
    const res = await safeFetch('http://192.168.1.10/a', {}, { allowPrivate: true });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(seen.map(s => s.url), ['http://192.168.1.10/a', 'http://192.168.1.11/b']);
  });

  await test('refuses a redirect to cloud metadata', async () => {
    routes['http://192.168.1.10/evil'] = { status: 301, location: 'http://169.254.169.254/latest/meta-data/' };
    await assert.rejects(safeFetch('http://192.168.1.10/evil', {}, { allowPrivate: true }), /Redirect refused/);
    assert.strictEqual(seen.length, 1);
  });

  await test('refuses a relative redirect to loopback via absolute host', async () => {
    routes['http://192.168.1.10/loop'] = { status: 307, location: 'http://127.0.0.1:3000/api/settings' };
    await assert.rejects(safeFetch('http://192.168.1.10/loop', {}, { allowPrivate: true }), /Redirect refused/);
  });

  await test('resolves relative Location against the current URL', async () => {
    routes['http://192.168.1.10/rel'] = { status: 302, location: '/next' };
    await safeFetch('http://192.168.1.10/rel', {}, { allowPrivate: true });
    assert.strictEqual(seen[1].url, 'http://192.168.1.10/next');
  });

  await test('stops after too many redirects', async () => {
    routes['http://192.168.1.10/r0'] = { status: 302, location: '/r1' };
    routes['http://192.168.1.10/r1'] = { status: 302, location: '/r2' };
    routes['http://192.168.1.10/r2'] = { status: 302, location: '/r3' };
    routes['http://192.168.1.10/r3'] = { status: 302, location: '/r4' };
    await assert.rejects(safeFetch('http://192.168.1.10/r0', {}, { allowPrivate: true }), /Too many redirects/);
  });

  await test('refuses a blocked first URL', async () => {
    await assert.rejects(safeFetch('http://169.254.169.254/', {}, { allowPrivate: true }), /not allowed/);
    assert.strictEqual(seen.length, 0);
  });

  await test('trimSlashes trims in linear time', () => {
    assert.strictEqual(trimSlashes('http://ha:8123/api///'), 'http://ha:8123/api');
    assert.strictEqual(trimSlashes('//states/x//', { leading: true }), 'states/x');
    assert.strictEqual(trimSlashes('//x', { leading: true, trailing: false }), 'x');
    const t = Date.now();
    trimSlashes('/'.repeat(200000) + 'x');
    assert.ok(Date.now() - t < 200);
  });

  if (failed) process.exit(1);
  checks.done();
})();
