'use strict';
const checks = require('./_checks');
// Devices that keep failing are tried less often but never dropped, and a
// Modbus device that never answers can't hang the polling cycle.
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-poll-backoff-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const config = (key, devices) => database.setConfig(key, JSON.stringify(devices));

const serialPath = require.resolve('serialport');
require(serialPath);
require.cache[serialPath].exports = { SerialPort: class {
  open(callback) { callback(new Error('Serial device unreachable')); }
} };

(async () => {
  // The schedule: 3 failures, then 1, 3, 7, 7 … cycles skipped; a success resets it.
  const { createBackoff } = require('../modules/pollBackoff');
  const b = createBackoff('test');
  const attempts = [];
  for (let cycle = 0; cycle < 40; cycle++) {
    if (b.skip('unit')) continue;
    attempts.push(cycle);
    b.record('unit', false);
  }
  assert.deepStrictEqual(attempts, [0, 1, 2, 4, 8, 16, 24, 32]);
  b.record('unit', true);
  assert.strictEqual(b.skip('unit'), false);
  assert.strictEqual(b.failures('unit'), 0);
  console.log('ok - backoff schedule');

  // Modbus TCP against a gateway that accepts the connection but never
  // answers: the poll fails after the device timeout instead of hanging.
  const silent = net.createServer(() => {});
  await new Promise(r => silent.listen(0, '127.0.0.1', r));
  const modbus = require('../modules/modbus');
  modbus.availableProfiles.push({ id: 'fixture', registers: [{ address: 1, metric: 'a' }] });
  config('modbus_devices', [{ name: 'silent', enabled: true, host: '127.0.0.1', port: silent.address().port, profile: 'fixture', timeout: 500 }]);
  const started = Date.now();
  const outcome = await Promise.race([
    modbus.pollModbus(),
    new Promise(r => setTimeout(() => r('hung'), 8000)),
  ]);
  silent.close();
  assert.notStrictEqual(outcome, 'hung', 'the poll returned');
  assert.strictEqual(outcome.attempted, 1);
  assert.strictEqual(outcome.errors.length, 1);
  assert.doesNotMatch(outcome.error.message, /not a function/, 'connects with the real client method');
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  console.log('ok - a silent Modbus unit times out');

  // RS232: a device that has failed many times is still tried now and then
  // (it used to be dropped after 10 failures until a restart).
  const rs232 = require('../modules/rs232');
  rs232.availableProfiles.push({ id: 'fixture', commands: [], protocol: 'query' });
  config('rs232_devices', [{ name: 'unplugged', enabled: true, profile: 'fixture' }]);
  const tried = [];
  for (let cycle = 0; cycle < 60; cycle++) if ((await rs232.pollRs232()).attempted) tried.push(cycle);
  assert.ok(tried.length >= 9 && tried[tried.length - 1] >= 50, `still tried late on: ${tried}`);
  console.log('ok - an RS232 device that keeps failing is never dropped');

  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
