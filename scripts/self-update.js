#!/usr/bin/env node
'use strict';
/**
 * Replaces the running Epilykos container with one from a newer image
 * (Settings → Updates on Docker Compose with the Docker socket mounted).
 *
 * A container cannot replace itself: stopping it ends the process doing the
 * work. So the app starts this script in a short-lived helper container from
 * the NEW image (modules/dockerUpdate.js), and the helper does the swap:
 *
 *   1. rename the old container out of the way and stop it
 *   2. create the new one under the old name with the same settings
 *   3. start it and wait until it is healthy
 *   4. remove the old container (and its image, if nothing else uses it)
 *
 * If the new one does not come up healthy, it is removed and the old one is
 * renamed back and started again. The last line printed is
 * "RESULT {json}"; the app reads it from this helper's log after the restart.
 *
 *   node self-update.js <old container id> <new image id>
 *
 * The settings copied are what Docker Compose (or docker run) gave the old
 * container: volumes, ports, devices, groups, restart policy, networks,
 * environment, labels. The image's own defaults (environment such as
 * EPILYKOS_BUILD_ID and PATH, command, healthcheck…) are left out so the new
 * image's values apply; copying them would keep the old build's identity.
 */
const docker = require('../modules/dockerApi');

const HEALTH_WAIT_MS = Number(process.env.UPDATE_HEALTH_WAIT_MS) || 180000;
const NO_HEALTHCHECK_RUNNING_MS = 20000;
const POLL_MS = Number(process.env.UPDATE_POLL_MS) || 2000;

const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);

/** Networks the container is attached to through its NetworkMode only (no endpoint list). */
function plainNetworkMode(mode) {
  return !mode || mode === 'host' || mode === 'none' || /^container:/.test(mode);
}

/**
 * The create request for the replacement container. Pure, for tests.
 * old: GET /containers/<id>/json; oldImage: GET /images/<old image>/json.
 * Returns { name, body, extraNetworks: [{ name, endpoint }] } — Docker before
 * API 1.44 accepts only one network at create, the rest are connected after.
 */
function buildCreateBody(old, oldImage, newImageId) {
  const c = old.Config || {};
  const ic = (oldImage && oldImage.Config) || {};
  const shortId = String(old.Id || '').slice(0, 12);

  const imageEnv = new Set(ic.Env || []);
  const body = {
    Image: c.Image || newImageId,
    Env: (c.Env || []).filter(e => !imageEnv.has(e)),
    Labels: {},
    Tty: !!c.Tty,
    OpenStdin: !!c.OpenStdin,
    StdinOnce: !!c.StdinOnce,
    AttachStdin: !!c.AttachStdin,
    AttachStdout: !!c.AttachStdout,
    AttachStderr: !!c.AttachStderr,
    HostConfig: { ...(old.HostConfig || {}) },
  };

  const imageLabels = ic.Labels || {};
  for (const [k, v] of Object.entries(c.Labels || {})) {
    if (imageLabels[k] !== v) body.Labels[k] = v;
  }
  // Compose compares this with the service image; the new id keeps a later
  // `docker compose up -d` from recreating the container again for nothing.
  if (body.Labels['com.docker.compose.image']) body.Labels['com.docker.compose.image'] = newImageId;

  for (const key of ['Cmd', 'Entrypoint', 'Healthcheck']) {
    if (c[key] != null && !same(c[key], ic[key])) body[key] = c[key];
  }
  for (const key of ['WorkingDir', 'User', 'StopSignal', 'Domainname']) {
    if (c[key] && c[key] !== ic[key]) body[key] = c[key];
  }
  if (c.StopTimeout != null) body.StopTimeout = c.StopTimeout;
  if (c.Hostname && c.Hostname !== shortId) body.Hostname = c.Hostname;
  for (const key of ['ExposedPorts', 'Volumes']) {
    const own = Object.keys(c[key] || {}).filter(k => !(ic[key] || {})[k]);
    if (own.length) body[key] = Object.fromEntries(own.map(k => [k, {}]));
  }

  const extraNetworks = [];
  const mode = body.HostConfig.NetworkMode;
  const networks = (old.NetworkSettings && old.NetworkSettings.Networks) || {};
  if (!plainNetworkMode(mode)) {
    const endpoint = n => {
      const e = {};
      if (n.IPAMConfig) e.IPAMConfig = n.IPAMConfig;
      if (n.Links) e.Links = n.Links;
      if (n.DriverOpts) e.DriverOpts = n.DriverOpts;
      const aliases = (n.Aliases || []).filter(a => a !== shortId && a !== old.Id);
      if (aliases.length) e.Aliases = aliases;
      return e;
    };
    const names = Object.keys(networks);
    const first = names.includes(mode) ? mode : names[0];
    if (first) body.NetworkingConfig = { EndpointsConfig: { [first]: endpoint(networks[first]) } };
    for (const n of names) if (n !== first) extraNetworks.push({ name: n, endpoint: endpoint(networks[n]) });
  }

  return { name: String(old.Name || '').replace(/^\//, ''), body, extraNetworks };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`${new Date().toISOString()} ${msg}`);

/** Resolves when the container is healthy (or running, with no healthcheck); throws otherwise. */
async function waitHealthy(id, api = docker) {
  const until = Date.now() + HEALTH_WAIT_MS;
  let runningSince = null;
  for (;;) {
    const st = (await api.call('GET', `/containers/${id}/json`)).State || {};
    if (!st.Running) throw new Error(`the new container stopped (exit code ${st.ExitCode}${st.Error ? `, ${st.Error}` : ''})`);
    if (st.Health) {
      if (st.Health.Status === 'healthy') return;
      if (st.Health.Status === 'unhealthy') throw new Error('the new container reported unhealthy');
    } else {
      runningSince = runningSince || Date.now();
      if (Date.now() - runningSince >= NO_HEALTHCHECK_RUNNING_MS) return;
    }
    if (Date.now() > until) throw new Error(`the new container was not healthy after ${Math.round(HEALTH_WAIT_MS / 1000)} s`);
    await sleep(POLL_MS);
  }
}

async function swap(oldId, newImageId, api = docker) {
  const old = await api.call('GET', `/containers/${oldId}/json`);
  const oldImage = await api.call('GET', `/images/${old.Image}/json`).catch(() => null);
  const { name, body, extraNetworks } = buildCreateBody(old, oldImage, newImageId);
  const parked = `${name}-previous`;
  log(`updating ${name}: ${String(old.Image).slice(7, 19)} → ${String(newImageId).slice(7, 19)}`);

  await api.call('DELETE', `/containers/${encodeURIComponent(parked)}?force=true`).catch(() => {});
  await api.call('POST', `/containers/${oldId}/rename?name=${encodeURIComponent(parked)}`);
  let newId = null;
  try {
    log('stopping the running container');
    await api.call('POST', `/containers/${oldId}/stop?t=30`, { timeoutMs: 60000 });
    const created = await api.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body });
    newId = created.Id;
    for (const n of extraNetworks) {
      await api.call('POST', `/networks/${encodeURIComponent(n.name)}/connect`, { body: { Container: newId, EndpointConfig: n.endpoint } });
    }
    log('starting the new container');
    await api.call('POST', `/containers/${newId}/start`);
    await waitHealthy(newId, api);
  } catch (err) {
    log(`update failed: ${err.message}; putting the previous version back`);
    if (newId) await api.call('DELETE', `/containers/${newId}?force=true`).catch(e => log(`could not remove the new container: ${e.message}`));
    else await api.call('DELETE', `/containers/${encodeURIComponent(name)}?force=true`).catch(() => {});
    await api.call('POST', `/containers/${oldId}/rename?name=${encodeURIComponent(name)}`).catch(e => log(`could not rename back: ${e.message}`));
    await api.call('POST', `/containers/${oldId}/start`).catch(e => log(`could not start the previous container: ${e.message}`));
    return { ok: false, error: err.message, rolledBack: true };
  }
  log('new container is healthy; removing the previous one');
  await api.call('DELETE', `/containers/${oldId}?force=true`).catch(e => log(`could not remove the previous container: ${e.message}`));
  if (old.Image !== newImageId) {
    await api.call('DELETE', `/images/${old.Image}`).then(() => log('previous image removed'), () => {});
  }
  return { ok: true, container: newId };
}

async function main() {
  const [oldId, newImageId] = process.argv.slice(2);
  let result;
  try {
    if (!oldId || !newImageId) throw new Error('usage: self-update.js <old container id> <new image id>');
    result = await swap(oldId, newImageId);
  } catch (err) {
    log(`update failed before anything changed: ${err.message}`);
    result = { ok: false, error: err.message, rolledBack: false };
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { buildCreateBody, swap, waitHealthy };
