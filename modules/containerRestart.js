'use strict';
/**
 * Restart Epilykos from Settings → System when it runs in Docker (an
 * EpilykosOS appliance restarts through its host service instead, see
 * routes/system.js).
 *
 *   docker   the Docker socket is mounted: ask Docker to restart this
 *            container, which works whatever its restart policy is
 *   exit     no socket: stop cleanly (the same path as SIGTERM) and rely on
 *            the container's restart policy (`restart: unless-stopped` in
 *            docker-compose.yaml) to start it again
 *   none     not in Docker: nothing to offer
 *
 * @module modules/containerRestart
 */
const dockerUpdate = require('./dockerUpdate');
const docker = require('./dockerApi');
const { logger } = require('./logger');

// Docker waits this long for Epilykos to finish its clean shutdown before killing it.
const STOP_TIMEOUT_S = 25;

let api = docker;                          // replaced in tests
let terminate = () => process.kill(process.pid, 'SIGTERM');
let selfIdFn = () => docker.selfId();
let availabilityFn = () => dockerUpdate.availability();

function setForTests({ stub, idFn, kill, availability } = {}) {
  api = stub || docker;
  selfIdFn = idFn || (() => docker.selfId());
  terminate = kill || (() => process.kill(process.pid, 'SIGTERM'));
  availabilityFn = availability || (() => dockerUpdate.availability());
}

/** 'docker' | 'exit' | 'none' */
function mode() {
  const a = availabilityFn();
  if (a === 'ready') return 'docker';
  if (a === 'no-socket') return 'exit';
  return 'none';
}

/**
 * Check the restart can be done and return the function that does it, so the
 * caller can answer the request first (the restart ends the reply's process).
 * Rejects with a `status` error when it can't be done.
 */
async function prepare() {
  const m = mode();
  if (m === 'none') throw Object.assign(new Error('Restart is only available on EpilykosOS and Docker'), { status: 404 });
  if (m === 'exit') return { mode: m, go: () => terminate() };
  const id = selfIdFn();
  try {
    await api.call('GET', `/containers/${id}/json`, { timeoutMs: 10000 });
  } catch (e) {
    throw Object.assign(new Error(`Docker would not let Epilykos restart itself: ${e.message}`), { status: 502 });
  }
  return {
    mode: m,
    go: async () => {
      try {
        await api.call('POST', `/containers/${id}/restart?t=${STOP_TIMEOUT_S}`, { timeoutMs: (STOP_TIMEOUT_S + 30) * 1000 });
      } catch (e) {
        // The reply is lost when this process is stopped mid-call; only a refusal reaches here.
        logger.warn(`Docker restart failed (${e.message}); stopping so the restart policy starts it again`);
        terminate();
      }
    }
  };
}

module.exports = { mode, prepare, setForTests, STOP_TIMEOUT_S };
