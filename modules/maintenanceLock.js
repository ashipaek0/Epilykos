'use strict';

const DEFAULT_TIMEOUT_MS = 5000;
const locks = new Map();

function acquireLocalLock(label, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof label !== 'string' || !label) return Promise.reject(new TypeError('Lock label must be a non-empty string'));
  let state = locks.get(label);
  if (!state) { state = { held: false, waiters: [] }; locks.set(label, state); }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    const grant = () => {
      state.held = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        const next = state.waiters.shift();
        if (next) next.grant();
        else {
          state.held = false;
          if (locks.get(label) === state) locks.delete(label);
        }
      });
    };
    waiter.grant = grant;
    if (!state.held && state.waiters.length === 0) { grant(); return; }
    state.waiters.push(waiter);
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      waiter.timer = setTimeout(() => {
        const index = state.waiters.indexOf(waiter);
        if (index !== -1) state.waiters.splice(index, 1);
        reject(Object.assign(new Error(`Maintenance lock '${label}' timed out after ${timeoutMs}ms`), { code: 'LOCK_BUSY' }));
      }, timeoutMs);
    }
  });
}

async function acquireLock(label, options = {}) {
  const started = performance.now();
  const releaseLocal = await acquireLocalLock(label, options);
  const file = process.env.EPILYKOS_MAINTENANCE_LOCK;
  if (label !== 'maintenance' || !file) return releaseLocal;
  try {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const budget = Number.isFinite(timeout) && timeout >= 0
      ? Math.max(0, timeout - (performance.now() - started)) : Infinity;
    const lease = await require('./maintenanceFileLock').acquireFileLease(file, budget);
    const release = () => { lease.release(); releaseLocal(); };
    release.leaseFd = lease.fd; // a native child can retain this same kernel lease
    return release;
  } catch (error) { releaseLocal(); throw error; }
}

async function withLock(label, fn, options) {
  const release = await acquireLock(label, options);
  try { return await fn(); } finally { release(); }
}

function reset() {
  for (const state of locks.values()) {
    for (const waiter of state.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(() => {});
    }
  }
  locks.clear();
}

module.exports = { acquireLock, withLock, reset, DEFAULT_TIMEOUT_MS };
