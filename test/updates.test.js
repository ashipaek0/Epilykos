'use strict';
const checks = require('./_checks');
// Settings → Updates: the feed CI publishes, comparing it with this build
// (release vs weekly rebuild), one notification per build, and "Update now"
// on Docker against a stand-in Docker API: the replacement container gets
// the compose settings but the NEW image's defaults, a failed start puts the
// old one back, and the restarted app reads how it went.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-updates-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.SETTINGS_PASSWORD;
delete process.env.UPDATE_CHECK;
delete process.env.EPILYKOS_HOST_SOCKET;
process.env.UPDATE_HEALTH_WAIT_MS = '300';
process.env.UPDATE_POLL_MS = '10';
Object.assign(process.env, { EPILYKOS_CHANNEL: 'latest', EPILYKOS_BUILD_ID: '100.1', EPILYKOS_COMMIT: 'a'.repeat(40), EPILYKOS_BUILT_AT: '2026-10-05T03:20:00Z' });

const express = require('express');
const database = require('../modules/database');
database.initializeDatabase();
const { setSettingsPassword } = require('../modules/sessionAuth');
const updates = require('../modules/updates');
const dockerApi = require('../modules/dockerApi');
const dockerUpdate = require('../modules/dockerUpdate');
const { buildCreateBody, swap } = require('../scripts/self-update');
const events = require('../modules/notifications/events');

const mine = updates.installed();
const entry = (id, at, extra) => Object.assign({ buildId: id, version: mine.version, commit: 'a'.repeat(40), builtAt: at, kind: 'rebuild', notes: [] }, extra);

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  // ── Comparing ─────────────────────────────────────────────────────────
  const same = { latest: entry('100.1', mine.builtAt), history: [entry('100.1', mine.builtAt)] };
  assert.equal(updates.compare(mine, same).state, 'up-to-date');
  const rebuild = entry('140.1', '2026-10-12T03:20:00Z');
  let r = updates.compare(mine, { latest: rebuild, history: [rebuild, entry('100.1', mine.builtAt)] });
  assert.equal(r.state, 'available'); assert.equal(r.kind, 'rebuild'); assert.equal(r.behind, 1);
  const release = entry('150.1', '2026-10-14T10:00:00Z', { kind: 'release', commit: 'b'.repeat(40), notes: ['Fix Phocos polling', 'Add Updates page'] });
  r = updates.compare(mine, { latest: release, history: [release, rebuild, entry('100.1', mine.builtAt)] });
  assert.equal(r.kind, 'release', 'a new commit anywhere since this build makes it a release');
  assert.deepEqual(r.notes, ['Fix Phocos polling', 'Add Updates page']);
  assert.equal(r.behind, 2);
  assert.equal(updates.compare({ ...mine, buildId: null }, same).state, 'unknown-build');
  console.log('ok - same build is up to date; a newer build of the same commit is a rebuild; new commits make a release with notes');

  // ── The feed CI writes ────────────────────────────────────────────────
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-feed-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('commit', '-q', '--allow-empty', '-m', 'first'); const c1 = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'Fix the gauge'); git('commit', '-q', '--allow-empty', '-m', 'Add Updates page');
  const c2 = git('rev-parse', 'HEAD');
  const script = path.join(__dirname, '..', '.github', 'scripts', 'update-feed.js');
  const feedFile = path.join(repo, 'latest.json');
  const rec = (commit, id, at) => { const p = path.join(repo, `rec-${id}.json`); fs.writeFileSync(p, JSON.stringify({ image: 'irunmole/epilykos', digest: 'sha256:' + id, tag: 'irunmole/epilykos:latest', commit, version: '1.0.0', build_id: id, built_at: at })); return p; };
  const runFeed = p => execFileSync('node', [script, 'latest', p, feedFile], { cwd: repo, encoding: 'utf8' });
  runFeed(rec(c1, '1.1', '2026-10-01T00:00:00Z'));
  runFeed(rec(c2, '2.1', '2026-10-02T00:00:00Z'));
  runFeed(rec(c2, '3.1', '2026-10-09T00:00:00Z'));
  const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
  assert.equal(feed.latest.buildId, '3.1'); assert.equal(feed.latest.kind, 'rebuild'); assert.deepEqual(feed.latest.notes, []);
  assert.equal(feed.history[1].kind, 'release'); assert.deepEqual(feed.history[1].notes, ['Add Updates page', 'Fix the gauge']);
  assert.equal(feed.latest.image, 'irunmole/epilykos:latest');
  assert.deepEqual(feed.history.map(e => e.buildId), ['3.1', '2.1', '1.1']);
  for (const wf of ['docker-build.yml', 'docker-build-dev.yml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', wf), 'utf8');
    assert.match(text, /EPILYKOS_BUILD_ID=\$\{\{ steps\.meta\.outputs\.build_id \}\}/, `${wf} writes the build id into the image`);
    assert.match(text, /update-feed\.js (latest|dev) digests\/digest-epilykos\.json feed\/(latest|dev)\.json/, `${wf} publishes the feed`);
  }
  console.log('ok - the feed lists builds newest first with the commit subjects since the previous build; both workflows publish it');

  // ── Checking, one notification per build ─────────────────────────────
  const sent = [];
  const origEmit = events.emitEvent;
  events.emitEvent = (type, fields) => sent.push({ type, fields });
  let feedReply = { ok: true, json: async () => ({ latest: rebuild, history: [rebuild] }) };
  const urls = [];
  updates.setFetchForTests(async url => { urls.push(url); if (feedReply instanceof Error) throw feedReply; return feedReply; });
  r = await updates.check();
  assert.equal(r.state, 'available'); assert.equal(r.kind, 'rebuild');
  assert.equal(urls[0], `${updates.FEED_BASE}/latest.json`);
  await updates.check();
  assert.equal(sent.length, 1, 'one notification per build'); assert.equal(sent[0].type, 'update.available');
  assert.match(sent[0].fields.message, /Security updates/);
  feedReply = new Error('getaddrinfo ENOTFOUND');
  r = await updates.check();
  assert.equal(r.state, 'available', 'no internet keeps the update it already knew about'); assert.match(r.error, /ENOTFOUND/);
  assert.ok(events.EVENT_TYPES['update.available'], 'listed in the notification catalogue');
  console.log('ok - checking reads <channel>.json, notifies once per build, and survives no internet');

  // ── The replacement container ─────────────────────────────────────────
  const OLD_ID = 'c'.repeat(64);
  const oldImage = { Id: 'sha256:' + '1'.repeat(64), Config: {
    Env: ['PATH=/usr/local/bin:/usr/bin', 'NODE_VERSION=22.1.0', 'EPILYKOS_BUILD_ID=100.1'],
    Cmd: ['node', 'server.js'], Entrypoint: ['/usr/local/bin/epilykos-entrypoint'], WorkingDir: '/app',
    Healthcheck: { Test: ['CMD', 'node', '-e', 'x'] }, ExposedPorts: { '3000/tcp': {} }, Labels: { 'org.opencontainers.image.version': '22' },
  } };
  const oldContainer = {
    Id: OLD_ID, Name: '/epilykos', Image: oldImage.Id,
    Config: {
      Image: 'irunmole/epilykos:latest', Hostname: OLD_ID.slice(0, 12),
      Env: [...oldImage.Config.Env, 'TZ=Africa/Lagos'], Cmd: oldImage.Config.Cmd, Entrypoint: oldImage.Config.Entrypoint,
      WorkingDir: '/app', Healthcheck: oldImage.Config.Healthcheck, ExposedPorts: { '3000/tcp': {} },
      Labels: { 'org.opencontainers.image.version': '22', 'com.docker.compose.project': 'epilykos', 'com.docker.compose.service': 'epilykos', 'com.docker.compose.image': oldImage.Id },
    },
    HostConfig: { Binds: ['/home/pi/epilykos/data:/app/data', '/var/run/docker.sock:/var/run/docker.sock'], RestartPolicy: { Name: 'unless-stopped' }, PortBindings: { '3000/tcp': [{ HostPort: '3000' }] }, NetworkMode: 'epilykos_default', GroupAdd: ['dialout'] },
    NetworkSettings: { Networks: {
      epilykos_default: { Aliases: ['epilykos', OLD_ID.slice(0, 12)], NetworkID: 'n1', IPAddress: '172.18.0.2' },
      mqtt_net: { Aliases: ['epilykos'], NetworkID: 'n2' },
    } },
    Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
    State: { Running: true },
  };
  const NEW_IMAGE = 'sha256:' + '2'.repeat(64);
  const built = buildCreateBody(oldContainer, oldImage, NEW_IMAGE);
  assert.equal(built.name, 'epilykos');
  assert.equal(built.body.Image, 'irunmole/epilykos:latest');
  assert.deepEqual(built.body.Env, ['TZ=Africa/Lagos'], 'only what compose set; the build id and PATH come from the new image');
  for (const k of ['Cmd', 'Entrypoint', 'WorkingDir', 'Healthcheck', 'Hostname', 'ExposedPorts']) assert.equal(built.body[k], undefined, `${k} comes from the new image`);
  assert.deepEqual(built.body.Labels, { 'com.docker.compose.project': 'epilykos', 'com.docker.compose.service': 'epilykos', 'com.docker.compose.image': NEW_IMAGE });
  assert.deepEqual(built.body.HostConfig, oldContainer.HostConfig, 'volumes, ports, devices, groups and restart policy unchanged');
  assert.deepEqual(built.body.NetworkingConfig, { EndpointsConfig: { epilykos_default: { Aliases: ['epilykos'] } } });
  assert.deepEqual(built.extraNetworks, [{ name: 'mqtt_net', endpoint: { Aliases: ['epilykos'] } }]);
  const hostNet = buildCreateBody({ ...oldContainer, HostConfig: { NetworkMode: 'host' }, NetworkSettings: { Networks: { host: {} } } }, oldImage, NEW_IMAGE);
  assert.equal(hostNet.body.NetworkingConfig, undefined); assert.deepEqual(hostNet.extraNetworks, []);
  console.log('ok - the new container keeps the compose settings and takes the new image\'s defaults (build id, PATH, healthcheck)');

  // A stand-in Docker Engine.
  function fakeDocker({ health = 'healthy', pullError = null, pulledImage = NEW_IMAGE } = {}) {
    const calls = [];
    const containers = { [OLD_ID]: JSON.parse(JSON.stringify(oldContainer)) };
    let helperLog = Buffer.alloc(0);
    const api = {
      calls, containers,
      available: () => true,
      setHelperLog(text) {
        const parts = text.split('\n').map(l => { const b = Buffer.from(l + '\n'); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); });
        helperLog = Buffer.concat(parts);
      },
      async request(method, p) { calls.push(`${method} ${p}`); return { status: 200, body: helperLog }; },
      async call(method, p, opts = {}) {
        calls.push(`${method} ${p.split('?')[0]}${p.includes('?') ? '?' + p.split('?')[1].split('&')[0] : ''}`);
        let m;
        if (method === 'GET' && (m = /^\/containers\/([^/]+)\/json$/.exec(p))) {
          const c = containers[m[1]];
          if (!c) throw Object.assign(new Error('Docker: No such container'), { status: 404 });
          return c;
        }
        if (method === 'GET' && /^\/images\/sha256:1+\/json$/.test(p)) return oldImage;
        if (method === 'GET' && /^\/images\/irunmole%2Fepilykos%3Alatest\/json$/.test(p)) return { Id: pulledImage, Config: { Env: ['EPILYKOS_BUILD_ID=150.1'] } };
        if (method === 'POST' && p.startsWith('/images/create')) return pullError ? [{ status: 'Pulling' }, { error: pullError }] : [{ status: 'Downloaded newer image' }];
        if (method === 'GET' && p.startsWith('/containers/json')) return Object.values(containers).filter(c => c.Labels && c.Labels['io.epilykos.updater']).map(c => ({ Id: c.Id, State: c.State.Running ? 'running' : 'exited' }));
        if (method === 'POST' && p.startsWith('/containers/create')) {
          const id = (Object.keys(containers).length + 1).toString(16).repeat(64).slice(0, 64);
          containers[id] = { Id: id, Name: '/' + decodeURIComponent(p.split('name=')[1]), Labels: opts.body.Labels, body: opts.body, State: { Running: false } };
          return { Id: id };
        }
        if (method === 'POST' && (m = /^\/containers\/([^/]+)\/start$/.exec(p))) {
          const c = containers[m[1]]; c.State = { Running: true, Health: c.Labels && c.Labels['io.epilykos.updater'] ? undefined : { Status: health } };
          return null;
        }
        return null;
      },
    };
    return api;
  }

  let api = fakeDocker();
  let out = await swap(OLD_ID, NEW_IMAGE, api);
  assert.equal(out.ok, true);
  const order = api.calls.filter(c => !c.startsWith('GET'));
  assert.deepEqual(order.slice(0, 6), [
    'DELETE /containers/epilykos-previous?force=true',
    `POST /containers/${OLD_ID}/rename?name=epilykos-previous`,
    `POST /containers/${OLD_ID}/stop?t=30`,
    'POST /containers/create?name=epilykos',
    `POST /networks/mqtt_net/connect`,
    `POST /containers/${out.container}/start`,
  ]);
  assert.ok(order.includes(`DELETE /containers/${OLD_ID}?force=true`), 'old container removed');
  assert.ok(order.includes(`DELETE /images/${oldImage.Id}`), 'old image removed');
  assert.deepEqual(api.containers[out.container].body.Env, ['TZ=Africa/Lagos']);

  api = fakeDocker({ health: 'unhealthy' });
  out = await swap(OLD_ID, NEW_IMAGE, api);
  assert.equal(out.ok, false); assert.equal(out.rolledBack, true); assert.match(out.error, /unhealthy/);
  const back = api.calls.filter(c => !c.startsWith('GET'));
  const newId = Object.keys(api.containers).find(id => id !== OLD_ID);
  assert.deepEqual(back.slice(-3), [`DELETE /containers/${newId}?force=true`, `POST /containers/${OLD_ID}/rename?name=epilykos`, `POST /containers/${OLD_ID}/start`]);
  assert.ok(!back.includes(`DELETE /containers/${OLD_ID}?force=true`), 'the old container is kept');
  api = fakeDocker({ health: 'starting' });
  out = await swap(OLD_ID, NEW_IMAGE, api);
  assert.equal(out.rolledBack, true); assert.match(out.error, /not healthy after/);
  console.log('ok - the swap stops the old container, starts the new one, waits for healthy; unhealthy or too slow puts the old one back');

  // ── Update now (app side) ─────────────────────────────────────────────
  api = fakeDocker({ pulledImage: oldImage.Id });
  dockerUpdate.setDockerForTests(api, () => OLD_ID);
  assert.equal(dockerUpdate.availability(), 'ready');
  assert.deepEqual(await dockerUpdate.apply(), { state: 'current' });
  assert.equal(dockerUpdate.applying(), null);

  api = fakeDocker({ pullError: 'toomanyrequests: rate limit' });
  dockerUpdate.setDockerForTests(api, () => OLD_ID);
  await assert.rejects(dockerUpdate.apply(), /could not download the update: toomanyrequests/);

  api = fakeDocker();
  dockerUpdate.setDockerForTests(api, () => OLD_ID);
  out = await dockerUpdate.apply();
  assert.deepEqual(out, { state: 'applying', toBuild: '150.1' });
  const helper = Object.values(api.containers).find(c => c.Labels && c.Labels['io.epilykos.updater']);
  assert.equal(helper.Name, '/epilykos-updater');
  assert.equal(helper.body.Image, NEW_IMAGE, 'the helper runs the new image');
  assert.deepEqual(helper.body.Cmd, [OLD_ID, NEW_IMAGE]);
  assert.deepEqual(helper.body.HostConfig, { Binds: ['/var/run/docker.sock:/var/run/docker.sock'], NetworkMode: 'none' });
  assert.equal(helper.State.Running, true);
  assert.equal(dockerUpdate.applying().toBuild, '150.1');
  assert.deepEqual(dockerUpdate.splitRef('registry.local:5000/epilykos'), { fromImage: 'registry.local:5000/epilykos', tag: 'latest' });
  assert.deepEqual(dockerUpdate.splitRef('irunmole/epilykos:dev'), { fromImage: 'irunmole/epilykos', tag: 'dev' });
  assert.equal(dockerUpdate.splitRef('irunmole/epilykos@sha256:abc'), null, 'a pinned digest cannot move');

  // While the helper runs, still installing; once it exits, its RESULT line is read.
  assert.equal((await dockerUpdate.reconcile()).state, 'applying');
  helper.State = { Running: false };
  api.setHelperLog('2026-10-16T10:00:00Z stopping the running container\n2026-10-16T10:00:05Z update failed: the new container reported unhealthy; putting the previous version back\nRESULT {"ok":false,"error":"the new container reported unhealthy","rolledBack":true}');
  const res1 = await dockerUpdate.reconcile();
  assert.equal(res1.ok, false); assert.equal(res1.rolledBack, true); assert.equal(res1.toBuild, '150.1');
  assert.equal(res1.log.length, 2); assert.ok(!res1.log.some(l => l.startsWith('RESULT')));
  assert.equal(dockerUpdate.applying(), null, 'done');
  assert.ok(api.calls.includes(`DELETE /containers/${helper.Id}?force=true`), 'helper removed');
  assert.equal(dockerApi.demuxLogs(Buffer.from('plain text')), 'plain text');
  console.log('ok - Update now pulls, stops when nothing is new, runs the helper from the new image, and the restarted app reads the result');

  // ── Routes ────────────────────────────────────────────────────────────
  setSettingsPassword('admin-password');
  const app = express();
  app.use(express.json());
  app.use('/api/updates', require('../routes/updates').router());
  const server = await new Promise(rs => { const s = app.listen(0, '127.0.0.1', () => rs(s)); });
  try {
    let g = await request(server, 'GET', '/api/updates');
    assert.equal(g.status, 200);
    assert.equal(g.body.installed.buildId, '100.1'); assert.equal(g.body.method.kind, 'docker');
    assert.equal(g.body.status.state, 'available'); assert.equal(g.body.lastResult.ok, false);
    let a = await request(server, 'POST', '/api/updates/apply', { password: 'wrong' });
    assert.equal(a.status, 403);
    api = fakeDocker({ pulledImage: oldImage.Id });
    dockerUpdate.setDockerForTests(api, () => OLD_ID);
    a = await request(server, 'POST', '/api/updates/apply', { password: 'admin-password' });
    assert.equal(a.status, 200); assert.equal(a.body.state, 'current');
    a = await request(server, 'POST', '/api/updates/auto', { on: false });
    assert.equal(a.body.auto, false); assert.equal(updates.autoCheck(), false);
    await request(server, 'POST', '/api/updates/result/dismiss', {});
    g = await request(server, 'GET', '/api/updates');
    assert.equal(g.body.lastResult, null);

    // Compose without the socket: no button, the commands instead.
    dockerUpdate.setDockerForTests({ ...api, available: () => false }, () => OLD_ID);
    g = await request(server, 'GET', '/api/updates');
    assert.equal(g.body.method.kind, 'compose');
    a = await request(server, 'POST', '/api/updates/apply', { password: 'admin-password' });
    assert.equal(a.status, 400); assert.match(a.body.error, /docker-compose\.yaml/);
  } finally { server.close(); }
  console.log('ok - the routes report the build and how to update; installing needs the admin password');

  // ── EpilykosOS: the appliance installs; the app asks and reports ──────
  const net = require('net');
  const sock = path.join(tmp, 'host.sock');
  const hostCalls = [];
  let hostApp = { state: 'idle', current_version: '2.7.0-dev+aaaa', last_result: null };
  const host = net.createServer(conn => {
    let buf = '';
    conn.on('data', d => {
      buf += d;
      if (!buf.includes('\n')) return;
      const req = JSON.parse(buf.split('\n')[0]);
      hostCalls.push(req);
      let reply = { ok: false, error: 'unknown action' };
      if (req.action === 'update_status') reply = { ok: true, app: hostApp, os: { version: 'abc1234', available: false } };
      if (req.action === 'update_check') reply = { ok: true, app: { ...hostApp, available: true, latest_version: '2.8.0-dev+bbbb' }, os: { version: 'abc1234', available: false } };
      if (req.action === 'update_apply') reply = req.target === 'os' ? { ok: false, error: 'EpilykosOS updates are not published yet' } : { ok: true, state: 'applying' };
      conn.end(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise(rs => host.listen(sock, rs));
  process.env.EPILYKOS_HOST_SOCKET = sock;
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/updates', require('../routes/updates').router());
  const server2 = await new Promise(rs => { const s2 = app2.listen(0, '127.0.0.1', () => rs(s2)); });
  try {
    await request(server2, 'POST', '/api/updates/check', {});
    let g = await request(server2, 'GET', '/api/updates');
    assert.equal(g.body.method.kind, 'epilykos-os');
    assert.equal(g.body.host.app.available, true); assert.equal(g.body.applying, null);
    let a = await request(server2, 'POST', '/api/updates/apply', { password: 'admin-password', target: 'app' });
    assert.equal(a.body.state, 'applying');
    assert.deepEqual(hostCalls.filter(c => c.action === 'update_apply'), [{ action: 'update_apply', target: 'app' }], 'the app names no digest');
    a = await request(server2, 'POST', '/api/updates/apply', { password: 'admin-password', target: 'os' });
    assert.equal(a.status, 400); assert.match(a.body.error, /EpilykosOS card/);
    assert.equal(hostCalls.filter(c => c.action === 'update_apply').length, 1, 'system updates never take the app path');
    hostApp = { ...hostApp, state: 'applying', job: { started_at: '2026-10-16T10:00:00Z', state: 'starting' } };
    g = await request(server2, 'GET', '/api/updates');
    assert.deepEqual(g.body.applying, { startedAt: '2026-10-16T10:00:00Z', step: 'starting' }, 'the page keeps waiting while the appliance works, and sees its step');
    hostApp = { state: 'idle', current_version: '2.7.0-dev+aaaa', last_result: { ok: false, error: 'The new version did not start, so the previous version was put back', rolled_back: true, release: '2.8.0-dev+bbbb', finished_at: '2026-10-16T10:05:00Z' } };
    g = await request(server2, 'GET', '/api/updates');
    assert.equal(g.body.lastResult.rolledBack, true); assert.equal(g.body.lastResult.toVersion, '2.8.0-dev+bbbb');
    await request(server2, 'POST', '/api/updates/result/dismiss', {});
    g = await request(server2, 'GET', '/api/updates');
    assert.equal(g.body.lastResult, null, 'dismissed results stay dismissed');
  } finally { server2.close(); host.close(); delete process.env.EPILYKOS_HOST_SOCKET; }
  console.log('ok - on EpilykosOS the appliance checks and installs; the page shows its progress and result');

  // ── Packaging ─────────────────────────────────────────────────────────
  const root = path.join(__dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /EPILYKOS_CHANNEL=\$\{EPILYKOS_CHANNEL\} EPILYKOS_BUILD_ID=\$\{EPILYKOS_BUILD_ID\}/);
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yaml'), 'utf8');
  assert.match(compose, /- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(compose, /full control of Docker/, 'the compose file says what the socket grants');
  const entry2 = fs.readFileSync(path.join(root, 'docker', 'entrypoint.sh'), 'utf8');
  assert.match(entry2, /sock_gid=\$\(stat -c %g "\$sock"\)/, 'the app joins the socket\'s group');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'self-update.js')));
  assert.ok(!/^scripts\b/m.test(fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')), 'the helper script ships in the image');
  console.log('ok - the image knows its build, compose mounts the socket with a warning, the entrypoint joins its group');

  events.emitEvent = origEmit;
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
