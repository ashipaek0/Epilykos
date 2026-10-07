const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

(async () => {
  const api = await import(pathToFileURL(`${process.cwd()}/public/js/api.js`));
  const originalFetch = global.fetch;
  const html = '<html><body>gateway secret diagnostic</body></html>';
  const response = (contentType, json, ok = true, status = 200) => ({
    ok, status, headers: { get: () => contentType }, json: async () => json
  });
  try {
    global.fetch = async () => response('application/json; charset=utf-8', { public: true });
    assert.deepEqual(await api.fetchPublicConfig(), { public: true });
    global.fetch = async () => ({ ok: false, status: 504, headers: { get: () => 'text/html' }, text: async () => html, json: async () => { throw new SyntaxError(html); } });
    await assert.rejects(api.fetchPublicConfig(), e => e.message.includes('/api/public-config') && e.message.includes('504') && !e.message.includes(html) && !(e instanceof SyntaxError));
    for (const res of [
      response('text/html', html),
      response('application/json', null)
    ]) {
      if (res.headers.get() === 'application/json') res.json = async () => { throw new SyntaxError(html); };
      global.fetch = async () => res;
      await assert.rejects(api.fetchPublicConfig(), e => e.message.includes('Invalid API response') && e.message.includes('/api/public-config') && !e.message.includes(html));
    }

    global.fetch = async () => ({ ok: false, status: 504, headers: { get: () => 'text/html' }, text: async () => html, json: async () => { throw new SyntaxError(html); } });
    await assert.rejects(api.fetchDashboardState(), e => e.message.includes('/api/dashboard-state') && e.message.includes('504') && !e.message.includes(html) && !(e instanceof SyntaxError));
    for (const res of [
      { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => html, json: async () => { throw new SyntaxError(html); } },
      { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => html, json: async () => { throw new SyntaxError(html); } }
    ]) {
      global.fetch = async () => res;
      await assert.rejects(api.fetchDashboardState(), e => e.message.includes('Invalid API response') && !e.message.includes(html));
    }

    const src = fs.readFileSync('public/js/updater.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replace('updateWithState(state);', 'globalThis.__stateUpdated(state);');
    const wrapped = `globalThis.__testUpdater = (async () => { ${src}\n return updateAllComponents; })()`;
    let updateCount = 0;
    globalThis.updateWithState = () => { throw new Error('must not update on failed fetch'); };
    globalThis.fetchDashboardState = api.fetchDashboardState;
    globalThis.__stateUpdated = () => { updateCount++; };
    const update = await import(`data:text/javascript,${encodeURIComponent(wrapped)}`).then(() => globalThis.__testUpdater);
    const errors = [];
    const oldError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      global.fetch = async () => { throw new Error('temporary network failure'); };
      await update();
      assert.equal(updateCount, 0, 'failure must not trigger component update');
      global.fetch = async () => { throw new Error('different gateway failure'); };
      await update();
      await update();
      assert.equal(errors.length, 1, 'distinct failures within one outage should log once');
      assert.equal(updateCount, 0, 'failures must never trigger component update');
      global.fetch = async () => response('application/json', { ok: true });
      await update();
      assert.equal(updateCount, 1, 'success updates components exactly once');
      global.fetch = async () => { throw new Error('post-recovery failure'); };
      await update();
      assert.equal(errors.length, 2, 'success resets outage suppression');
      assert.equal(updateCount, 1, 'later failure does not trigger component update');
    } finally { console.error = oldError; }
  } finally { global.fetch = originalFetch; }
  checks.done();
})().catch(error => { console.error(error); process.exitCode = 1; });
