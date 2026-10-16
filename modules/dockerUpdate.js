'use strict';
/**
 * "Update now" on Docker Compose (Settings → Updates). Needs the Docker socket
 * mounted into the container (docker-compose.yaml), which gives this app
 * control of Docker on the host; without it the page shows the commands to
 * run instead.
 *
 * The app pulls its own image tag. If that brings a new image, it starts a
 * helper container from the new image that swaps the containers and puts the
 * old one back if the new one is not healthy (scripts/self-update.js). The
 * helper's last log line says how it went; the app that comes up afterwards
 * (new, or old after a rollback) reads it and removes the helper (reconcile).
 */
const fs = require('fs');
const docker = require('./dockerApi');
const { logger } = require('./logger');
const { getConfig, setConfig } = require('./database');

const LABEL = 'io.epilykos.updater';
const PULL_TIMEOUT_MS = 15 * 60 * 1000;

let api = docker;      // replaced in tests
let selfIdFn = () => docker.selfId();
let busy = false;

function setDockerForTests(stub, idFn) { api = stub || docker; selfIdFn = idFn || (() => docker.selfId()); }

function inContainer() {
  return !!selfIdFn() || fs.existsSync('/.dockerenv');
}

/** none (not in Docker) | no-socket (compose without the socket line) | ready */
function availability() {
  if (!inContainer()) return 'none';
  if (!(api.available ? api.available() : docker.available())) return 'no-socket';
  if (!selfIdFn()) return 'no-socket';
  return 'ready';
}

/** "irunmole/epilykos:latest" → { fromImage, tag }; null when pinned by digest or id. */
function splitRef(ref) {
  const s = String(ref || '');
  if (!s || s.startsWith('sha256:') || s.includes('@')) return null;
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  return colon > slash ? { fromImage: s.slice(0, colon), tag: s.slice(colon + 1) } : { fromImage: s, tag: 'latest' };
}

const envOf = (img, key) => {
  const e = ((img && img.Config && img.Config.Env) || []).find(v => v.startsWith(`${key}=`));
  return e ? e.slice(key.length + 1) : null;
};

function applying() {
  try { return JSON.parse(getConfig('update_applying') || 'null'); } catch (_) { return null; }
}
function lastResult() {
  try { return JSON.parse(getConfig('update_last_result') || 'null'); } catch (_) { return null; }
}

async function updaters() {
  const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
  return api.call('GET', `/containers/json?all=1&filters=${filters}`);
}

/**
 * Pull the image and, if it is new, start the swap. Resolves
 * { state: 'current' } or { state: 'applying', toBuild }.
 * After 'applying' this container is stopped within seconds.
 */
async function apply() {
  if (busy) throw Object.assign(new Error('An update is already running'), { status: 409 });
  if (availability() !== 'ready') throw Object.assign(new Error('Updating from here needs the Docker socket mounted (see docker-compose.yaml)'), { status: 400 });
  busy = true;
  try {
    const self = await api.call('GET', `/containers/${selfIdFn()}/json`);
    const ref = self.Config && self.Config.Image;
    const parts = splitRef(ref);
    if (!parts) throw Object.assign(new Error(`This container runs a fixed image (${ref}), not a tag that can move to a newer build. Change the image line in docker-compose.yaml to irunmole/epilykos:latest.`), { status: 400 });

    const running = (await updaters()).filter(c => c.State === 'running');
    if (running.length) throw Object.assign(new Error('An update is already running'), { status: 409 });

    logger.info(`[updates] Downloading ${ref}`);
    const pulled = await api.call('POST', `/images/create?fromImage=${encodeURIComponent(parts.fromImage)}&tag=${encodeURIComponent(parts.tag)}`, { timeoutMs: PULL_TIMEOUT_MS });
    const failed = Array.isArray(pulled) && pulled.find(l => l && (l.error || l.errorDetail));
    if (failed) throw Object.assign(new Error(`Docker could not download the update: ${failed.error || failed.errorDetail.message}`), { status: 502 });

    const img = await api.call('GET', `/images/${encodeURIComponent(ref)}/json`);
    if (img.Id === self.Image) {
      logger.info('[updates] Already running the newest image');
      return { state: 'current' };
    }

    // Leftover helpers from earlier updates (their results were read already).
    for (const c of await updaters()) await api.call('DELETE', `/containers/${c.Id}?force=true`).catch(() => {});

    const sock = (self.Mounts || []).find(m => m.Destination === docker.SOCKET || m.Destination === '/var/run/docker.sock');
    const name = String(self.Name || '/epilykos').replace(/^\//, '');
    const helper = await api.call('POST', `/containers/create?name=${encodeURIComponent(`${name}-updater`)}`, {
      body: {
        Image: img.Id,
        Entrypoint: ['node', '/app/scripts/self-update.js'],
        Cmd: [self.Id, img.Id],
        User: '0:0',
        WorkingDir: '/app',
        Env: ['DOCKER_SOCKET=/var/run/docker.sock', 'UPDATE_CHECK=off'],
        Labels: { [LABEL]: '1' },
        Healthcheck: { Test: ['NONE'] },
        HostConfig: { Binds: [`${(sock && sock.Source) || '/var/run/docker.sock'}:/var/run/docker.sock`], NetworkMode: 'none' },
      },
    });
    const record = {
      startedAt: new Date().toISOString(),
      fromBuild: process.env.EPILYKOS_BUILD_ID || null,
      toBuild: envOf(img, 'EPILYKOS_BUILD_ID'),
      fromImage: self.Image,
      toImage: img.Id,
      helper: helper.Id,
    };
    setConfig('update_applying', JSON.stringify(record));
    await api.call('POST', `/containers/${helper.Id}/start`);
    logger.warn(`[updates] Installing build ${record.toBuild || img.Id.slice(7, 19)}; Epilykos restarts in a moment`);
    return { state: 'applying', toBuild: record.toBuild };
  } finally {
    busy = false;
  }
}

/**
 * After a restart: read how the last update went from its helper, store it,
 * and remove the helper. Never throws.
 */
async function reconcile() {
  const pending = applying();
  if (!pending || availability() !== 'ready') return lastResult();
  try {
    const list = await updaters();
    const helper = list.find(c => c.Id === pending.helper) || list[0];
    if (helper && helper.State === 'running') return { state: 'applying', ...pending };
    let result = null, tail = [];
    if (helper) {
      const raw = await api.request('GET', `/containers/${helper.Id}/logs?stdout=1&stderr=1&tail=200`, { raw: true });
      const lines = docker.demuxLogs(raw.body).split('\n').filter(Boolean);
      const last = [...lines].reverse().find(l => l.startsWith('RESULT '));
      try { result = last ? JSON.parse(last.slice(7)) : null; } catch (_) { /* unreadable */ }
      tail = lines.filter(l => !l.startsWith('RESULT ')).slice(-30);
      await api.call('DELETE', `/containers/${helper.Id}?force=true`).catch(() => {});
    }
    const now = process.env.EPILYKOS_BUILD_ID || null;
    if (!result) {
      result = now && pending.toBuild && now === pending.toBuild
        ? { ok: true }
        : { ok: false, error: 'The update did not finish; the previous version is still running', rolledBack: true };
    }
    const out = { ...result, fromBuild: pending.fromBuild, toBuild: pending.toBuild, startedAt: pending.startedAt, finishedAt: new Date().toISOString(), log: tail };
    setConfig('update_last_result', JSON.stringify(out));
    setConfig('update_applying', '');
    if (out.ok) logger.info(`[updates] Updated to build ${now || pending.toBuild}`);
    else logger.warn(`[updates] Update failed: ${out.error}`);
    return out;
  } catch (err) {
    logger.warn(`[updates] Could not read the update result: ${err.message}`);
    return lastResult();
  }
}

module.exports = { availability, apply, reconcile, applying, lastResult, splitRef, setDockerForTests, LABEL };
