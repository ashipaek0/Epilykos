'use strict';
/**
 * test/phocos-ble.test.js — Phocos Any-Grid over Bluetooth (read-only GATT
 * profile). Fixtures are characteristic values captured from an Any-Grid
 * PSW-H 8 kW / 48 V (display firmware 00041.00) on battery, no grid.
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'phocos-ble-')));
const { BleGattTransport, decodeBlocks } = require(path.join(REPO, 'modules/dongle/bleGatt'));
const { getByPathForTest: getByPath } = require(path.join(REPO, 'modules/dongle'));
const { dongleProfileEntities } = require(path.join(REPO, 'modules/entityCatalog'));
const profile = JSON.parse(fs.readFileSync(path.join(REPO, 'profiles/dongles/phocos-anygrid-ble.json'), 'utf8'));

// First row of phocos-monitor-582B0A509F83.csv (12:51:18).
const CAPTURE = {
  live:   '00 00 00 00 f9 08 f3 01 5e 06 d6 05 14 00 c4 01 f0 14 00 00', // 229.7 V out, 1494 W, 53.60 V battery
  status: '5b 00 42 00 0e 00 06 00 20 00 02 00 42 00 00 00 00 00 00 00', // SOC 91, 66 °C, 14 A, mode 'B'
  pv1:    '2d 2d 2d 2d 2d 2e 2d 2d 20 20 12 00 88 09 c5 01 00 00 00 00', // 1.8 A, 244.0 V, 453 W
  pv2:    '20 20 20 20 20 20 20 20 20 20 13 00 a9 09 d9 01 00 00 00 00'  // 1.9 A, 247.3 V, 473 W
};
const raws = profile.blocks.map(b => Buffer.from(CAPTURE[b.id].replace(/ /g, ''), 'hex'));

function metricsFrom(data) {
  const out = {};
  for (const f of profile.fields) {
    const raw = getByPath(data, f.path);
    if (typeof raw === 'number') out[f.name] = parseFloat((raw * (f.scale || 1)).toFixed(4));
  }
  return out;
}

(async () => {
  // Profile shape
  assert.strictEqual(profile.protocol, 'ble-gatt');
  assert.strictEqual(profile.read_only, true);
  assert.deepStrictEqual(profile.blocks.map(b => `${b.service}/${b.characteristic}`), ['1810/2a03', '1810/2a04', '1811/2a11', '1811/2a12']);
  console.log('ok - profile shape');

  // Decode of the captured values
  const m = metricsFrom(decodeBlocks(profile, raws));
  assert.strictEqual(m.grid_voltage, 0);
  assert.strictEqual(m.output_voltage, 229.7);
  assert.strictEqual(m.output_frequency, 49.9);
  assert.strictEqual(m.output_va, 1630);
  assert.strictEqual(m.output_power, 1494);
  assert.strictEqual(m.load_percent, 20);
  assert.strictEqual(m.bus_voltage, 452);
  assert.strictEqual(m.battery_voltage, 53.6);
  assert.strictEqual(m.battery_soc, 91);
  assert.strictEqual(m.inverter_temp, 66);
  assert.strictEqual(m.battery_discharge_current, 14);
  assert.strictEqual(m.pv1_current, 1.8);
  assert.strictEqual(m.pv1_voltage, 244);
  assert.strictEqual(m.pv1_power, 453);
  assert.strictEqual(m.pv2_current, 1.9);
  assert.strictEqual(m.pv2_voltage, 247.3);
  assert.strictEqual(m.pv2_power, 473);
  assert.strictEqual(m.pv_power, 926);
  console.log('ok - captured values decode');

  // A missing characteristic leaves its fields (and the sum) out, the rest still decode
  const partial = metricsFrom(decodeBlocks(profile, [raws[0], raws[1], null, raws[3]]));
  assert.strictEqual(partial.output_power, 1494);
  assert.strictEqual(partial.pv1_power, undefined);
  assert.strictEqual(partial.pv_power, undefined);
  console.log('ok - missing block tolerated');

  // Transport: reads by (service, characteristic), never anything else
  const calls = [];
  const t = new BleGattTransport({ ble_address: '58:2b:0a:50:9f:83' }, profile, {
    read: async (address, reads) => { calls.push({ address, reads }); return raws; }
  });
  const data = await t.poll();
  assert.strictEqual(calls[0].address, '58:2B:0A:50:9F:83');
  assert.deepStrictEqual(calls[0].reads[0], { service: '1810', characteristic: '2a03' });
  assert.strictEqual(data.derived.pv_power, 926);
  await assert.rejects(new BleGattTransport({ ble_address: '58:2B:0A:50:9F:83' }, profile, { read: async () => [null, null, null, null] }).poll(), /no data/);
  assert.throws(() => new BleGattTransport({ host: '192.168.1.5' }, profile), /invalid Bluetooth address/);
  console.log('ok - transport');

  // Entity catalog: one path-addressed entity per field (mapping ids = paths)
  const ents = dongleProfileEntities(profile);
  assert.strictEqual(ents.length, profile.fields.length);
  assert.ok(ents.every(e => e.kind === 'path' && e.writable === false));
  assert.strictEqual(ents.find(e => e.name === 'pv_power').id, 'derived.pv_power');
  console.log('ok - entity catalog');

  console.log('# phocos-ble: all passed');
})().catch(err => { console.error('not ok -', err); process.exit(1); });
