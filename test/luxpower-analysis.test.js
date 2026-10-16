'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'lux-analysis-')));
const { decodeLuxpowerMetrics } = require('../modules/dongle');
const { modelFromWord, currentDivisor, identityFromHolding } = require('../modules/dongle/luxpowerModel');
const profile = require('../profiles/dongles/luxpower-geta.json');
const instance = () => ({ name: 'fixture', mappings: { soc: 'input:0x0005', charge: 'input:0x0051', discharge: 'input:0x0052' } });
test('SOC is low byte; lithium limits follow the live GETA units flag', () => {
  const i = instance();
  assert.deepEqual(decodeLuxpowerMetrics(profile, i, { 'holding:19': 26, 'input:5': 0x6450, 'input:80': 1026, 'input:81': 660, 'input:82': 700 }).metrics, { soc: 80, charge: 66, discharge: 70 });
  assert.deepEqual(decodeLuxpowerMetrics(profile, i, { 'input:80': 2, 'input:81': 660 }).metrics, { charge: 6.6 });
});
test('current-family overrides take precedence over the units bit', () => {
  for (const word of [4, 1]) assert.equal(currentDivisor(modelFromWord(word), 1026), 100);
  for (const word of [12, 14, 16]) assert.equal(currentDivisor(modelFromWord(word), 2), 10);
  assert.equal(currentDivisor(null, 1026), null);
});
test('partial pushes without flags or identity do not invent current limits', () => {
  assert.deepEqual(decodeLuxpowerMetrics(profile, instance(), { 'input:80': 1026, 'input:81': 660 }).metrics, {});
  const i = instance();
  decodeLuxpowerMetrics(profile, i, { 'holding:19': 26 });
  assert.deepEqual(decodeLuxpowerMetrics(profile, i, { 'input:81': 660 }).metrics, {});
  assert.deepEqual(decodeLuxpowerMetrics(profile, i, { 'input:80': 1, 'input:81': 660 }).metrics, {});
});
test('identity preserves raw words; GETA requires the app single-phase/type13 predicate', () => {
  const b = Buffer.alloc(80); b.writeUInt16LE(26, 38); b.writeUInt16LE(0x1234, 18);
  const id = identityFromHolding(b);
  assert.equal(id.model.geta, true); assert.equal(id.model.phase, 1); assert.equal(id.communicationVersion, 0x34);
  assert.equal(modelFromWord(27).geta, false); assert.equal(modelFromWord(0).geta, false);
  assert.throws(() => identityFromHolding(b.subarray(0, 38)), /short/i);
});
test('polling transport factory preserves configured protocol and compatibility options', () => {
  const { createLuxpowerTransport } = require('../modules/dongle');
  const config = { host: '127.0.0.1', dongle_serial: 'DT00000001', inverter_serial: 'IN00000001', protocol: 2, tls_policy: 'required' };
  const tcp = createLuxpowerTransport(config, profile);
  assert.equal(tcp._protocol, 2); assert.equal(tcp._tlsPolicy, 'required'); tcp.stop();
  const ble = createLuxpowerTransport({ ...config, transport: 'ble-luxpower', ble_address: 'AA:BB:CC:DD:EE:FF', ble_write_mode: 'chunked-no-response' }, profile);
  assert.equal(ble.protocol, 2); assert.equal(ble.writeMode, 'chunked-no-response');
});
test('optional identity failure does not invalidate a successful telemetry connection test', async () => {
  const { identityDiagnostic } = require('../modules/dongle/luxpowerModel');
  const r = await identityDiagnostic({ readRegisters: async () => { throw new Error('not supported'); } });
  assert.equal(r.identity, null); assert.equal(r.identityError, 'not supported');
});
