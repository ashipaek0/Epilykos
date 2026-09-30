'use strict';
/**
 * test/luxpower-ble.test.js — LuxPower dongle over Bluetooth
 * (modules/dongle/bleLuxpower.js) against frames captured from a real dongle
 * (DT62000575 / inverter 62003U2271, characteristic FF01), plus the Bluetooth
 * helper's reassembly of the 20-byte notifications.
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'lux-ble-')));
const { BleLuxpowerTransport, DEFAULT_CHAR_UUID } = require(path.join(REPO, 'modules/dongle/bleLuxpower'));
const { crc16Modbus } = require(path.join(REPO, 'modules/dongle/luxpowerTcp'));

// Request for input registers 0-39, byte-identical over TCP and Bluetooth.
const REQUEST = 'a11a0500200001c244543632303030353735120000043632303033553232373100002800b019';
// Reply notified on FF01 (six notifications joined). The outer dongle serial is zeroed over Bluetooth.
const RESPONSE = Buffer.from('a11a05006f0001c20000000000000000000061000104363230303355323237310000504000a0000000000006014f00000000000000000000009101000000008138000000000000f0000000e60840275c10881372014e02000000003b000000000000000300190020003700000026003d0e5d0eb36c', 'hex');
// Unsolicited holding-register push the dongle sends on the same characteristic.
const PUSH = Buffer.from('a11a0500bf0001c200000000000000000000b1000103363230303355323237310000a06011010036323030335532323731434a414100000c2100001a091e140d3701000000000000001a000400000b1e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000173b000000000000000000006400000000000000000089ac', 'hex');

const INSTANCE = { ble_address: 'a4:cb:8f:28:b0:02', dongle_serial: 'DT62000575', inverter_serial: '62003U2271' };

function stub(response) {
  const calls = [];
  return { calls, exchange: async (address, opts) => { calls.push({ address, ...opts }); return typeof response === 'function' ? response(opts.frame) : response; } };
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`not ok - ${name}\n  ${e.stack}`); }
}

(async () => {
  await test('read request goes to FF01 and decodes the real reply', async () => {
    const s = stub(RESPONSE);
    const t = new BleLuxpowerTransport(INSTANCE, { exchange: s.exchange });
    const values = await t.readRegisters(0, 40, 0x04);
    assert.strictEqual(s.calls.length, 1);
    assert.strictEqual(s.calls[0].address, 'A4:CB:8F:28:B0:02');
    assert.strictEqual(s.calls[0].writeUuid, DEFAULT_CHAR_UUID);
    assert.strictEqual(s.calls[0].notifyUuid, DEFAULT_CHAR_UUID);
    assert.strictEqual(s.calls[0].frame.toString('hex'), REQUEST);
    assert.strictEqual(values.length, 80);
    assert.strictEqual(values.readUInt16LE(0), 64);      // operational state
    assert.strictEqual(values.readUInt16LE(2), 160);     // PV1 16.0 V
    assert.strictEqual(values.readUInt16LE(8), 262);     // battery 26.2 V
    assert.strictEqual(values.readUInt16LE(10), 79);     // SOC 79 %
    assert.strictEqual(values.readUInt16LE(40), 2278);   // EPS 227.8 V
    assert.strictEqual(values.readUInt16LE(46), 5000);   // 50.00 Hz
  });

  await test('decodes through the luxpower-geta profile like the TCP path', async () => {
    const dongle = require(path.join(REPO, 'modules/dongle'));
    const profile = JSON.parse(fs.readFileSync(path.join(REPO, 'profiles/dongles/luxpower-geta.json'), 'utf8'));
    const t = new BleLuxpowerTransport(INSTANCE, { exchange: stub(RESPONSE).exchange });
    const words = dongle.luxpowerWordsFromBuffer(profile, await t.readRegisters(0, 40, 0x04), 0, 'input');
    const mappings = { battery_voltage: 'input:0x0004', battery_soc: 'input:0x0005', eps_power: 'input:0x0018' };
    const { metrics } = dongle.decodeLuxpowerMetrics(profile, { name: 'lux', mappings }, words);
    assert.strictEqual(metrics.battery_voltage, 26.2);
    assert.strictEqual(metrics.battery_soc, 79);
    assert.strictEqual(metrics.eps_power, 370);
  });

  await test('rejects a reply for another inverter', async () => {
    const other = Buffer.from(RESPONSE);
    other.write('62003U9999', 22, 'ascii');
    other.writeUInt16LE(crc16Modbus(other.slice(20, other.length - 2)), other.length - 2);
    const t = new BleLuxpowerTransport(INSTANCE, { exchange: stub(other).exchange });
    await assert.rejects(t.readRegisters(0, 40, 0x04), /inverter 62003U9999/);
  });

  await test('rejects a corrupted reply', async () => {
    const bad = Buffer.from(RESPONSE);
    bad[40] ^= 0xFF;
    const t = new BleLuxpowerTransport(INSTANCE, { exchange: stub(bad).exchange });
    await assert.rejects(t.readRegisters(0, 40, 0x04), /CRC mismatch/);
  });

  await test('rejects a reply with the wrong register count', async () => {
    const t = new BleLuxpowerTransport(INSTANCE, { exchange: stub(RESPONSE).exchange });
    await assert.rejects(t.readRegisters(0, 20, 0x04), /expected 20 registers, got 40/);
  });

  await test('write-single sends 0x06 and accepts the echo', async () => {
    const s = stub(frame => {
      // Echo: the request inner with action flipped to 0x01, zeroed dongle serial.
      const echo = Buffer.from(frame);
      echo.fill(0, 8, 18);
      echo[20] = 0x01;
      echo.writeUInt16LE(crc16Modbus(echo.slice(20, echo.length - 2)), echo.length - 2);
      return echo;
    });
    const t = new BleLuxpowerTransport(INSTANCE, { exchange: s.exchange });
    const echo = await t.writeRegister(64, 50);
    assert.strictEqual(s.calls[0].frame[21], 0x06);
    assert.strictEqual(echo.readUInt16LE(0), 50);
  });

  await test('invalid config fails at construction', () => {
    assert.throws(() => new BleLuxpowerTransport({ ...INSTANCE, ble_address: 'nope' }), /invalid Bluetooth address/);
    assert.throws(() => new BleLuxpowerTransport({ ...INSTANCE, inverter_serial: 'short' }), /inverter/);
    assert.throws(() => new BleLuxpowerTransport({ ...INSTANCE, dongle_serial: '' }), /dongle/);
  });

  await test('helper reassembles 20-byte notifications and skips pushes', () => {
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'modules/ble'))})
from ble_helper import lux_sync, lux_frame_length, lux_matches
req = bytes.fromhex(${JSON.stringify(REQUEST)})
stream = bytes.fromhex(${JSON.stringify(PUSH.toString('hex'))}) + bytes.fromhex(${JSON.stringify(RESPONSE.toString('hex'))})
buf, got = bytearray(), None
for i in range(0, len(stream), 20):          # arrives as 20-byte notifications
    buf.extend(stream[i:i + 20])
    while got is None:
        buf[:] = lux_sync(buf)
        need = lux_frame_length(buf)
        if need is None or len(buf) < need:
            break
        frame = bytes(buf[:need]); del buf[:need]
        if lux_matches(frame, req):
            got = frame
print(got.hex() if got else "none")
`;
    const r = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 30000 });
    if (r.error && r.error.code === 'ENOENT') { console.log('# skip - python3 not installed'); return; }
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), RESPONSE.toString('hex'));
  });

  if (failed) process.exit(1);
})();
