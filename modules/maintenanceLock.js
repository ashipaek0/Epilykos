'use strict';

const DEFAULT_TIMEOUT_MS = 5000;
const locks = new Map();

function acquireLock(label, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
        reject(new Error(`Maintenance lock '${label}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
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
