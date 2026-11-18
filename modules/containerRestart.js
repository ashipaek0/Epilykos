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
const { execFile } = require('child_process');
const { logger } = require('./logger');

// Docker waits this long for Epilykos to finish its clean shutdown before killing it.
const STOP_TIMEOUT_S = 25;

let api = docker;                          // replaced in tests
let terminate = () => process.kill(process.pid, 'SIGTERM');
let selfIdFn = () => docker.selfId();
let availabilityFn = () => dockerUpdate.availability();
/** The Windows installer build runs Epilykos as the "Epilykos" Windows service. */
let windowsFn = () => process.platform === 'win32' && process.env.EPILYKOS_INSTALLER === 'windows';
let schtasks = args => new Promise((resolve, reject) => execFile('schtasks.exe', args, { windowsHide: true, timeout: 30000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out))));

function setForTests({ stub, idFn, kill, availability, windows, tasks } = {}) {
  windowsFn = windows || (() => process.platform === 'win32' && process.env.EPILYKOS_INSTALLER === 'windows');
  schtasks = tasks || schtasks;
  api = stub || docker;
  selfIdFn = idFn || (() => docker.selfId());
  terminate = kill || (() => process.kill(process.pid, 'SIGTERM'));
  availabilityFn = availability || (() => dockerUpdate.availability());
}

/** 'service' (Windows) | 'docker' | 'exit' | 'none' */
function mode() {
  if (windowsFn()) return 'service';
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
  if (m === 'none') throw Object.assign(new Error('Restart is only available on EpilykosOS, Docker and the Windows installer'), { status: 404 });
  if (m === 'service') {
    // Stopping the service ends this process and anything it started, so the restart is run by the Task
    // Scheduler (as SYSTEM): stop the service, wait for it, start it again.
    return { mode: m, go: async () => {
      try {
        await schtasks(['/Create', '/TN', 'EpilykosRestart', '/TR', 'cmd /c "net stop Epilykos && net start Epilykos"', '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F']);
        await schtasks(['/Run', '/TN', 'EpilykosRestart']);
      } catch (e) {
        // Not stopping is deliberate: a clean stop would leave the service stopped (it only restarts after a crash).
        logger.error(`Windows restart could not be started (${e.message}); Epilykos keeps running. Restart the Epilykos service from Services instead.`);
      }
    } };
  }
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
