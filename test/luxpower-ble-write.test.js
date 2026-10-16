'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('Python BLE writes: long response, negotiated chunks, advertised support and no replay', () => {
  const r = spawnSync('python3', [path.join(__dirname, '../modules/ble/test_luxpower_write.py')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /Ran 4 tests/);
});
