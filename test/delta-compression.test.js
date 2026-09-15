#!/usr/bin/env node
/**
 * test/delta-compression.test.js — computeDelta fixtures (Phase 2 delta compression).
 * Plain node, no framework, no network, no DB.
 *
 * NOTE on extraction: server.js has boot side effects (express listen, dotenv,
 * requires) so it is NEVER required here. Instead computeDelta is extracted from
 * the server.js source text via brace-matching and eval'd in isolation. The
 * function is pure (no external references), so the isolated copy is faithful.
 *
 * Covers:
 *   (1) identical objects -> {}
 *   (2) nested one-leaf change -> sub-delta only (siblings omitted)
 *   (3) added key -> value included
 *   (4) deleted key -> null
 *   (5) equal primitives -> {}
 *   (6) changed primitive -> new value
 *   (7) same-length same-item arrays -> {}
 *   (8) array item change -> whole array
 *   (9) array length change -> whole array
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---- Extract computeDelta from server.js source (never require it) ----
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function extractFunction(src, header) {
  const start = src.indexOf(header);
  assert.ok(start !== -1, `header not found: ${header}`);
  let i = src.indexOf('{', start);
  assert.ok(i !== -1, 'opening brace not found');
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('unbalanced braces extracting ' + header);
}
const computeDelta = eval(extractFunction(SRC, 'function computeDelta(current, previous)') + '\ncomputeDelta');

// ---- Fixtures ----
check('identical objects -> {}', () => {
  assert.deepStrictEqual(computeDelta({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), {});
});

check('nested one-leaf change -> sub-delta only', () => {
  const d = computeDelta({ x: 1, nest: { keep: 'k', leaf: 2 } }, { x: 1, nest: { keep: 'k', leaf: 1 } });
  assert.deepStrictEqual(d, { nest: { leaf: 2 } });
});

check('added key -> value included', () => {
  assert.deepStrictEqual(computeDelta({ a: 1, b: 2 }, { a: 1 }), { b: 2 });
});

check('deleted key -> null', () => {
  assert.deepStrictEqual(computeDelta({ a: 1 }, { a: 1, gone: 9 }), { gone: null });
});

check('equal primitives -> {}', () => {
  assert.deepStrictEqual(computeDelta({ n: 5, s: 'x' }, { n: 5, s: 'x' }), {});
});

check('changed primitive -> new value', () => {
  assert.deepStrictEqual(computeDelta({ n: 6 }, { n: 5 }), { n: 6 });
});

check('same-length same-item arrays -> {}', () => {
  assert.deepStrictEqual(computeDelta({ arr: [1, 2, 3] }, { arr: [1, 2, 3] }), {});
});

check('array item change -> whole array', () => {
  assert.deepStrictEqual(computeDelta({ arr: [1, 9, 3] }, { arr: [1, 2, 3] }), { arr: [1, 9, 3] });
});

check('array length change -> whole array', () => {
  assert.deepStrictEqual(computeDelta({ arr: [1, 2] }, { arr: [1, 2, 3] }), { arr: [1, 2] });
});

console.log(`\nPASS delta-compression: ${passed} checks`);
