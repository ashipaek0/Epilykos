#!/usr/bin/env node
/**
 * test/ws-delta.test.js — applyDelta fixtures (Phase 2 WS delta merge).
 * Plain node, no framework, no network, no DOM.
 *
 * NOTE on extraction: public/js/ws-manager.js uses ES `export` syntax, so it
 * CANNOT be required from plain node. Instead applyDelta is extracted from the
 * file source text via brace-matching and eval'd in isolation. The function is
 * pure (no external references), so the isolated copy is faithful.
 *
 * Covers:
 *   (1) nested merge (deep keys merged, siblings kept)
 *   (2) array wholesale replace
 *   (3) deleted-key (null) removal
 *   (4) malformed delta null -> base unchanged
 *   (5) malformed delta string/array -> base unchanged
 *   (6) base immutability (input base not mutated)
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

// ---- Extract applyDelta from ws-manager.js source (ES export: never require it) ----
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ws-manager.js'), 'utf8');
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
const applyDelta = eval(extractFunction(SRC, 'function applyDelta(base, delta)') + '\napplyDelta');

// ---- Fixtures ----
check('nested merge keeps siblings', () => {
  const out = applyDelta(
    { x: 1, nest: { keep: 'k', leaf: 1 } },
    { nest: { leaf: 2 } }
  );
  assert.deepStrictEqual(out, { x: 1, nest: { keep: 'k', leaf: 2 } });
});

check('array replaced wholesale', () => {
  const out = applyDelta({ arr: [1, 2, 3], other: 'o' }, { arr: [9] });
  assert.deepStrictEqual(out, { arr: [9], other: 'o' });
});

check('deleted-key (null) removed', () => {
  const out = applyDelta({ a: 1, gone: 9 }, { gone: null });
  assert.deepStrictEqual(out, { a: 1 });
  assert.ok(!('gone' in out));
});

check('malformed delta null -> base unchanged', () => {
  const base = { a: 1 };
  assert.deepStrictEqual(applyDelta(base, null), { a: 1 });
});

check('malformed delta string/array -> base unchanged', () => {
  const base = { a: 1 };
  assert.deepStrictEqual(applyDelta(base, 'nope'), { a: 1 });
  assert.deepStrictEqual(applyDelta(base, [1, 2]), { a: 1 });
});

check('base immutability (input not mutated)', () => {
  const base = { x: 1, nest: { keep: 'k', leaf: 1 } };
  const frozen = JSON.parse(JSON.stringify(base));
  applyDelta(base, { x: 2, nest: { leaf: 2 } });
  assert.deepStrictEqual(base, frozen);
});

console.log(`\nPASS ws-delta: ${passed} checks`);
