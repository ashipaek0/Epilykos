'use strict';
/**
 * test/container-restart.test.js — Settings → System → Restart in Docker.
 *
 * Without EpilykosOS's host service the Restart button is still offered in
 * Docker: Docker is asked to restart this container when its socket is
 * mounted, otherwise Epilykos stops cleanly and the restart policy starts it.
 * It is refused when not in Docker, and the reply goes out before the restart.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const containerRestart = require('../modules/containerRestart');
const router = require('../routes/system');
delete process.env.EPILYKOS_HOST_SOCKET;

function handlers(method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} exists`);
  return layer.route.stack.map(s => s.handle);
}
async function call(method, routePath) {
  let status = 200, data, finish = null;
  const res = {
    status(code) { status = code; return this; },
    json(value) { data = value; return this; },
    once(ev, fn) { if (ev === 'finish') finish = fn; return this; }
  };
  for (const handle of handlers(method, routePath)) {
    let nextCalled = false;
    await handle({ body: {} }, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { status, data, finish };
}

const ID = 'a'.repeat(64);
const calls = [];
const docker = {
  async call(method, p) {
    calls.push(`${method} ${p}`);
    if (docker.refuse) throw Object.assign(new Error('Docker: permission denied'), { status: 403 });
    return {};
  }
};

(async () => {
  // Not in Docker: nothing offered.
  containerRestart.setForTests({ availability: () => 'none' });
  let r = await call('get', '/');
  assert.deepEqual(r.data, { appliance: false });
  r = await call('post', '/restart');
  assert.equal(r.status, 404);
  assert.match(r.data.error, /EpilykosOS and Docker/);
  console.log('ok - not in Docker: no restart offered, the route says 404');

  // Docker without the socket: stop, let the restart policy start it.
  let killed = 0;
  containerRestart.setForTests({ availability: () => 'no-socket', kill: () => { killed++; } });
  r = await call('get', '/');
  assert.deepEqual(r.data, { appliance: false, container: { restart: 'exit' } });
  r = await call('post', '/restart');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { success: true, mode: 'exit' });
  assert.equal(killed, 0, 'the reply goes out before anything stops');
  assert.equal(typeof r.finish, 'function');
  console.log('ok - Docker, no socket: status says exit, reply first');

  // Docker with the socket: Docker restarts this container.
  containerRestart.setForTests({ availability: () => 'ready', stub: docker, idFn: () => ID, kill: () => { killed++; } });
  r = await call('get', '/');
  assert.deepEqual(r.data, { appliance: false, container: { restart: 'docker' } });
  calls.length = 0;
  r = await call('post', '/restart');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { success: true, mode: 'docker' });
  assert.deepEqual(calls, [`GET /containers/${ID}/json`], 'checked first; the restart waits for the reply');
  const plan = await containerRestart.prepare();
  calls.length = 0;
  await plan.go();
  assert.deepEqual(calls, [`POST /containers/${ID}/restart?t=${containerRestart.STOP_TIMEOUT_S}`]);
  assert.equal(killed, 0);
  console.log('ok - Docker with the socket: checks access, answers, then asks Docker to restart this container');

  // Docker refuses the check: the user is told and nothing stops.
  docker.refuse = true;
  r = await call('post', '/restart');
  assert.equal(r.status, 502);
  assert.match(r.data.error, /would not let Epilykos restart itself.*permission denied/);
  assert.equal(r.finish, null);
  // A refusal on the restart itself falls back to a clean stop.
  const p2 = await containerRestart.prepare().catch(e => e);
  assert.ok(p2 instanceof Error);
  docker.refuse = false;
  const p3 = await containerRestart.prepare();
  docker.refuse = true;
  await p3.go();
  assert.equal(killed, 1, 'falls back to stopping so the restart policy starts it');
  console.log('ok - Docker refusals: reported before answering; a late refusal falls back to a clean stop');

  // On an appliance the host service is used, not Docker.
  containerRestart.setForTests({ availability: () => 'ready', stub: docker, idFn: () => ID });
  assert.equal(containerRestart.mode(), 'docker');

  // The page: a Restart card only, nothing appliance-only.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/system-settings.js'), 'utf8');
  assert.match(src, /data\.container/);
  assert.match(src, /function renderContainer/);
  const body = /function renderContainer\(\) \{([\s\S]*?)\n  \}/.exec(src)[1];
  assert.match(body, /data-act="restart"/);
  assert.doesNotMatch(body, /shutdown|ssh|factory/i);
  assert.match(body, /restart: unless-stopped/);
  assert.doesNotMatch(src.slice(src.indexOf('if (state.container)'), src.indexOf('if (state.container)') + 80), /renderSystem/);
  new vm.Script(src);   // still parses
  console.log('ok - the System page offers Restart alone in Docker');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
