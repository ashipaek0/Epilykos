'use strict';
/**
 * Check counting for the plain (non node:test) fixtures.
 *
 * A test requires this first, then calls `done()` after its last check:
 *
 *   const checks = require('./_checks');   // or: import checks from './_checks.js';
 *   ...
 *   checks.done();
 *
 * Every assertion made through `assert` / `node:assert` / `assert/strict`
 * counts as a check. done() prints "# checks: N", which test/run-all.js
 * requires: a test that stops early (an await that never settles lets Node
 * exit with code 0) never reaches done(), so it fails instead of passing
 * silently. done(extra) adds checks made without assert (e.g. a child
 * process's self-test).
 */
const Module = require('module');
const assert = require('assert');

let count = 0;
const wrapped = new WeakMap();
function counting(fn) {
  if (typeof fn !== 'function' || fn === assert.AssertionError) return fn;
  if (wrapped.has(fn)) return wrapped.get(fn);
  const w = function (...args) { count++; return fn.apply(this, args); };
  Object.defineProperties(w, Object.getOwnPropertyDescriptors(fn));
  wrapped.set(fn, w);
  return w;
}
// Methods on the shared module objects: covers assert.equal(...) in CommonJS
// and in ES modules (default import), and named imports once synced below.
for (const target of [assert, assert.strict]) {
  for (const key of Object.keys(target)) {
    if (key === 'AssertionError' || key === 'strict' || typeof target[key] !== 'function') continue;
    target[key] = counting(target[key]);
  }
}
// assert(value) itself: hand CommonJS requires a counting function.
const callable = new Map();
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  const m = origLoad.call(this, request, ...rest);
  if (typeof m === 'function' && /^(node:)?assert(\/strict)?$/.test(request)) {
    if (!callable.has(m)) {
      const c = function (...args) { count++; return m.apply(this, args); };
      Object.defineProperties(c, Object.getOwnPropertyDescriptors(m));
      callable.set(m, c);
    }
    return callable.get(m);
  }
  return m;
};
if (typeof Module.syncBuiltinESMExports === 'function') Module.syncBuiltinESMExports();

let finished = false;
function done(extra = 0) {
  if (finished) return;
  finished = true;
  const n = count + (Number(extra) || 0);
  if (!(n > 0)) {
    console.error('# checks: 0 — this test reported no checks');
    process.exitCode = 1;
    return;
  }
  console.log(`# checks: ${n}`);
}

/** A test that can't run here (e.g. python3 missing): reported, not failed. */
function skip(reason) {
  if (finished) return;
  finished = true;
  console.log(`# checks: skipped (${reason})`);
}

module.exports = { done, skip, get count() { return count; } };
module.exports.default = module.exports;
