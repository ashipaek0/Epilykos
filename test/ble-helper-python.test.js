'use strict';
/**
 * test/ble-helper-python.test.js — runs the pure-function self-test built into
 * modules/ble/ble_helper.py (sample flattening, Modbus response framing,
 * address checks). Needs python3 only; bleak/aiobmsble are imported lazily.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, '..', 'modules', 'ble', 'ble_helper.py');
const r = spawnSync('python3', [script, '--self-test'], { encoding: 'utf8', timeout: 60000 });
if (r.error && r.error.code === 'ENOENT') {
  console.log('skip - python3 not installed');
  process.exit(0);
}
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0 || !/^ok$/m.test(r.stdout || '')) {
  console.error('not ok - ble_helper.py --self-test failed');
  process.exit(1);
}
console.log('ok - ble_helper.py self-test');
