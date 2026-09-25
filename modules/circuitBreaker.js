'use strict';

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 60000;
const MAX_ENTRIES = 200;

const registry = new Map();

function getBreaker(id) {
  if (registry.has(id)) return registry.get(id);
  if (registry.size >= MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    registry.delete(oldest);
  }
  const breaker = {
    _failures: 0,
    _state: 'CLOSED',
    _openedAt: 0,
    async execute(fn) {
      if (this._state === 'OPEN') {
        if (Date.now() - this._openedAt >= RESET_TIMEOUT_MS) {
          // half-open probe (async-aware: rejections re-open)
          try {
            const result = await fn();
            this._failures = 0;
            this._state = 'CLOSED';
            this._openedAt = 0;
            return result;
          } catch (e) {
            this._openedAt = Date.now();
            throw e;
          }
        }
        throw new Error('circuit-open:' + id);
      }
      try {
        const result = await fn();
        this._failures = 0;
        return result;
      } catch (e) {
        this._failures += 1;
        if (this._failures >= FAILURE_THRESHOLD) {
          this._state = 'OPEN';
          this._openedAt = Date.now();
        }
        throw e;
      }
    },
    getState() { return this._state; },
    getFailures() { return this._failures; },
  };
  registry.set(id, breaker);
  return breaker;
}

function resetAll() {
  registry.clear();
}

module.exports = { getBreaker, resetAll, FAILURE_THRESHOLD, RESET_TIMEOUT_MS };
