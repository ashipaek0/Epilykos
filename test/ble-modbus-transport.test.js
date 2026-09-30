'use strict';
/**
 * test/ble-modbus-transport.test.js — modules/dongle/bleModbus.js frame
 * building/checking with a stubbed exchange (no Bluetooth needed).
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'ble-modbus-')));
const { BleModbusTransport, normalizeUuid, DEFAULT_WRITE_UUID, DEFAULT_NOTIFY_UUID } = require(path.join(REPO, 'modules/dongle/bleModbus'));
const { modbusCrc16 } = require(path.join(REPO, 'modules/modbus-frame'));

function withCrc(bytes) {
  const body = Buffer.from(bytes);
  const out = Buffer.alloc(body.length + 2);
  body.copy(out);
  out.writeUInt16LE(modbusCrc16(body), body.length);
  return out;
}

function stub(response) {
  const calls = [];
  return {
    calls,
    exchange: async (address, opts) => { calls.push({ address, ...opts }); return typeof response === 'function' ? response(opts.frame) : response; }
  };
}

(async () => {
  // UUIDs
  assert.strictEqual(normalizeUuid('FFD1'), '0000ffd1-0000-1000-8000-00805f9b34fb');
  assert.strictEqual(normalizeUuid('0000FFF1'), '0000fff1-0000-1000-8000-00805f9b34fb');
  assert.strictEqual(normalizeUuid('6E400002-B5A3-F393-E0A9-E50E24DCCA9E'), '6e400002-b5a3-f393-e0a9-e50e24dcca9e');
  assert.strictEqual(normalizeUuid('xyz'), null);

  // Construction
  assert.throws(() => new BleModbusTransport({ host: '192.168.1.5' }), /invalid Bluetooth address/);
  assert.throws(() => new BleModbusTransport({ ble_address: 'AA:BB:CC:DD:EE:FF', ble_write_uuid: 'nope' }), /write characteristic/);
  const d = new BleModbusTransport({ ble_address: 'aa:bb:cc:dd:ee:ff' });
  assert.strictEqual(d.address, 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(d.writeUuid, DEFAULT_WRITE_UUID);
  assert.strictEqual(d.notifyUuid, DEFAULT_NOTIFY_UUID);
  assert.strictEqual(d.unitId, 1);
  console.log('ok - construction + UUID normalisation');

  // Read: request frame is Modbus-RTU FC3 with CRC; response data is returned
  {
    const s = stub(withCrc([0x01, 0x03, 0x04, 0x00, 0x57, 0x02, 0x08]));
    const t = new BleModbusTransport({ host: 'AA:BB:CC:DD:EE:FF', ble_write_uuid: 'ffd1', ble_notify_uuid: 'fff1' }, s);
    const data = await t.readRegisters(0x0100, 2);
    assert.deepStrictEqual([...data], [0x00, 0x57, 0x02, 0x08]);
    assert.strictEqual(s.calls.length, 1);
    assert.deepStrictEqual(s.calls[0].frame, withCrc([0x01, 0x03, 0x01, 0x00, 0x00, 0x02]));
    assert.strictEqual(s.calls[0].writeUuid, '0000ffd1-0000-1000-8000-00805f9b34fb');
    console.log('ok - read registers');
  }

  // Unit id + function code 4 honoured
  {
    const s = stub(withCrc([0xff, 0x04, 0x02, 0x12, 0x34]));
    const t = new BleModbusTransport({ ble_address: 'AA:BB:CC:DD:EE:FF', modbus_unit_id: 255, function_code: 4 }, s);
    const data = await t.readRegisters(0x0000, 1);
    assert.strictEqual(data.readUInt16BE(0), 0x1234);
    assert.deepStrictEqual(s.calls[0].frame.subarray(0, 2), Buffer.from([0xff, 0x04]));
    console.log('ok - unit id / function code');
  }

  // Errors: bad CRC, Modbus exception, wrong unit
  {
    const bad = withCrc([0x01, 0x03, 0x02, 0x00, 0x01]); bad[bad.length - 1] ^= 0xff;
    await assert.rejects(new BleModbusTransport({ ble_address: 'AA:BB:CC:DD:EE:FF' }, stub(bad)).readRegisters(0, 1), /CRC mismatch/);
    await assert.rejects(new BleModbusTransport({ ble_address: 'AA:BB:CC:DD:EE:FF' }, stub(withCrc([0x01, 0x83, 0x02]))).readRegisters(0, 1), /Modbus exception 2/);
    await assert.rejects(new BleModbusTransport({ ble_address: 'AA:BB:CC:DD:EE:FF' }, stub(withCrc([0x02, 0x03, 0x02, 0x00, 0x01]))).readRegisters(0, 1), /unexpected unit id/);
    console.log('ok - response validation');
  }

  // Write single register: echo must match
  {
    const s = stub(frame => frame); // FC6 echoes the request
    const t = new BleModbusTransport({ ble_address: 'AA:BB:CC:DD:EE:FF' }, s);
    await t.writeRegister(0xE004, 3);
    assert.deepStrictEqual(s.calls[0].frame, withCrc([0x01, 0x06, 0xe0, 0x04, 0x00, 0x03]));
    const wrong = stub(withCrc([0x01, 0x06, 0xe0, 0x05, 0x00, 0x03]));
    await assert.rejects(new BleModbusTransport({ ble_address: 'AA:BB:CC:DD:EE:FF' }, wrong).writeRegister(0xE004, 3), /echo mismatch/);
    console.log('ok - write register');
  }

  console.log('# ble-modbus transport: all passed');
})().catch(err => { console.error('not ok -', err); process.exit(1); });
