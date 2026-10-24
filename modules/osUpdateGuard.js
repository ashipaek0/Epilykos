'use strict';
/**
 * The EpilykosOS update guard (guard-v1, OS update design §7.4). On a
 * paired EpilykosOS the host's guard file is mounted read-only and
 * EPILYKOS_OS_UPDATE_GUARD names it; elsewhere (Docker, development, older
 * EpilykosOS) there is no OS update and nothing is blocked.
 *
 *   idle         nothing to respect
 *   active       an OS update is installing: no app maintenance at all
 *   pending      an OS update is ready or on trial: no change to the app's
 *                data compatibility (restore); backups, snapshots and
 *                checks may run
 *   reconciling  the host is checking an interrupted update: as active
 *
 * Read under the shared maintenance lock (modules/maintenanceLock.js). A
 * named but missing or unreadable guard fails closed.
 */
const fs = require('fs');

const STATES = ['idle', 'active', 'pending', 'reconciling'];

function state(file = process.env.EPILYKOS_OS_UPDATE_GUARD) {
  if (!file) return 'idle';
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').slice(0, 4096));
    if (value && value.schema === 1 && STATES.includes(value.state)) return value.state;
  } catch (_) { /* fall through: fail closed */ }
  return 'reconciling';
}

function refusal(current) {
  const why = current === 'pending' ? 'an EpilykosOS update is waiting to finish'
    : current === 'active' ? 'an EpilykosOS update is being installed'
      : 'EpilykosOS is checking an interrupted update';
  return Object.assign(new Error(`Not now: ${why}. See Settings → Updates.`), { code: 'LOCK_BUSY', osUpdate: current });
}

/** Throw when this maintenance may not run now. */
function assertAllowed({ allowPending = false } = {}) {
  const current = state();
  if (current === 'idle' || (current === 'pending' && allowPending)) return current;
  throw refusal(current);
}

module.exports = { state, assertAllowed, STATES };
