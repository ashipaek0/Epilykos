/** DATA filesystem headroom, measured as the application user. */
'use strict';
const fs = require('node:fs');
const GiB = 1073741824;

function unavailable() { return { available: false, state: 'unavailable' }; }

function evaluateSpace(total, available) {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(available)
      || available < 0 || available > total) return unavailable();
  const warning = Math.max(2 * GiB, Math.ceil(total / 5));
  const floor = Math.max(GiB, Math.ceil(total / 10));
  return {
    available: true,
    total_bytes: total,
    available_bytes: available,
    warning_bytes: warning,
    maintenance_floor_bytes: floor,
    state: available <= floor ? 'critical' : available < warning ? 'warning' : 'ok'
  };
}

function readSpace(directory) {
  try {
    const stat = fs.statfsSync(directory, { bigint: true });
    // bavail excludes blocks reserved for root; the app runs as uid 1000.
    return evaluateSpace(Number(stat.blocks * stat.bsize), Number(stat.bavail * stat.bsize));
  } catch (_) { return unavailable(); }
}

module.exports = { evaluateSpace, readSpace };
