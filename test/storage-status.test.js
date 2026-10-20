'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateSpace, readSpace } = require('../modules/storageStatus');
const GiB = 1073741824;

test('large DATA uses percentage thresholds and preserves exact warning boundaries', () => {
  assert.equal(evaluateSpace(20 * GiB, 4 * GiB).state, 'ok');
  assert.equal(evaluateSpace(20 * GiB, 4 * GiB - 1).state, 'warning');
  assert.equal(evaluateSpace(20 * GiB, 2 * GiB).state, 'critical');
  assert.equal(evaluateSpace(20 * GiB, 2 * GiB + 1).state, 'warning');
  const result = evaluateSpace(20 * GiB, 3 * GiB);
  assert.equal(result.warning_bytes, 4 * GiB);
  assert.equal(result.maintenance_floor_bytes, 2 * GiB);
  assert.equal(result.available_bytes, 3 * GiB);
});

test('small DATA uses absolute thresholds and reports zero space critically', () => {
  const result = evaluateSpace(8 * GiB, 0);
  assert.equal(result.warning_bytes, 2 * GiB);
  assert.equal(result.maintenance_floor_bytes, GiB);
  assert.equal(result.state, 'critical');
  assert.equal(evaluateSpace(8 * GiB, 2 * GiB).state, 'ok');
});

test('invalid filesystem measurements never appear healthy', () => {
  for (const [total, available] of [[0, 0], [-1, 1], [NaN, 1], [Infinity, 1],
    [10, NaN], [10, Infinity], [10, 11], [10, -1], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
    assert.equal(evaluateSpace(total, available).state, 'unavailable');
  }
});

test('readSpace measures the writable data filesystem and handles absent paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-space-'));
  try {
    const result = readSpace(dir);
    assert.equal(result.available, true);
    assert.ok(result.total_bytes > 0);
    assert.ok(result.available_bytes >= 0 && result.available_bytes <= result.total_bytes);
    assert.equal(readSpace(path.join(dir, 'missing')).state, 'unavailable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readSpace uses unprivileged available blocks, not free blocks reserved for root', () => {
  const original = fs.statfsSync;
  try {
    fs.statfsSync = () => ({ bsize: 4096n, blocks: 2097152n, bavail: 131072n, bfree: 1048576n });
    const result = readSpace('/fixture/data');
    assert.equal(result.total_bytes, 8 * GiB);
    assert.equal(result.available_bytes, 536870912);
    assert.equal(result.state, 'critical');
  } finally { fs.statfsSync = original; }
});
