'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cworth-bms-'));
process.chdir(tmp);
const { buildPollRanges, parseModbusReadResponse, modbusCrc16 } = require(path.join(REPO, 'modules/modbus-frame'));
const { decodeProfileRegisters } = require(path.join(REPO, 'modules/bmsWired'));
const profile = JSON.parse(fs.readFileSync(path.join(REPO, 'profiles/rs232/cworth-ce-h6k-bms.json'), 'utf8'));

assert.strictEqual(profile.protocol, 'modbus-rtu');
assert.strictEqual(profile.transport, 'rs232');
const ranges = buildPollRanges(profile.metrics);
assert.deepStrictEqual(ranges, [{ start: 0x1306, count: 8 }, { start: 0x131C, count: 0x22 }]);
for (const metric of profile.metrics) {
  assert.doesNotMatch(`${metric.name} ${metric.field}`, /soh|capacity|remain|design_capacity|pv_|load_|grid_/i);
}

function valuesFor(currentRaw) {
  const values = new Map([[0x1306, 5379], [0x1307, currentRaw], [0x130b, 79], [0x130d, 1234],
    [0x131c, 5600], [0x131d, 4400], [0x131e, 1000], [0x131f, 1000],
    [0x1320, 3400], [0x1321, 4], [0x1322, 3300], [0x1323, 12], [0x1324, 35], [0x1326, 20]]);
  for (let i = 0; i < 16; i++) values.set(0x132a + i, 3301 + i);
  for (let i = 0; i < 4; i++) values.set(0x133a + i, 25 + i);
  return values;
}
function responseFor(range, values) {
  const data = Buffer.alloc(range.count * 2);
  for (let i = 0; i < range.count; i++) {
    const value = values.get(range.start + i) || 0;
    // Wire bytes are big-endian words; profile's LE swap reverses each word.
    data.writeUInt16BE(((value & 0xff) << 8) | ((value >> 8) & 0xff), i * 2);
  }
  const body = Buffer.concat([Buffer.from([1, 3, data.length]), data]);
  const crc = modbusCrc16(body);
  const frame = Buffer.alloc(body.length + 2);
  body.copy(frame);
  frame.writeUInt16LE(crc, body.length);
  return frame;
}
function readRegisterData(currentRaw) {
  const values = valuesFor(currentRaw);
  const registerData = {};
  for (const range of ranges) {
    const buf = parseModbusReadResponse(responseFor(range, values));
    assert.strictEqual(buf.length, range.count * 2);
    // Mirror production's BE-read followed by profile.byte_order LE byte swap.
    for (let i = 0; i < range.count && i * 2 < buf.length; i++) {
      let v = buf.readUInt16BE(i * 2);
      if (profile.byte_order === 'le') v = ((v & 0xff) << 8) | (v >> 8);
      registerData[range.start + i] = v;
    }
  }
  return registerData;
}
const decoded = decodeProfileRegisters(profile, readRegisterData(-250));
assert.strictEqual(decoded.pack_voltage, 53.79);
assert.strictEqual(decoded.pack_current, -25);
assert.strictEqual(decoded.soc, 79);
assert.strictEqual(decoded.cycle_count, 1234);
assert.strictEqual(decoded.charge_cutoff_voltage, 56);
assert.strictEqual(decoded.discharge_cutoff_voltage, 44);
assert.strictEqual(decoded.max_charge_current, 100);
assert.strictEqual(decoded.max_discharge_current, 100);
assert.strictEqual(decoded.highest_cell_voltage, 3.4);
assert.strictEqual(decoded.index_highest_cell, 4);
assert.strictEqual(decoded.lowest_cell_voltage, 3.3);
assert.strictEqual(decoded.index_lowest_cell, 12);
assert.strictEqual(decoded.highest_temperature, 35);
assert.strictEqual(decoded.lowest_temperature, 20);
for (let i = 1; i <= 16; i++) assert.strictEqual(decoded[`cell_voltage_${i}`], (3300 + i) / 1000);
for (let i = 1; i <= 4; i++) assert.strictEqual(decoded[`temp_sensor_${i}`], 24 + i);
assert.strictEqual(decodeProfileRegisters(profile, readRegisterData(250)).pack_current, 25);
const corrupt = responseFor(ranges[0], valuesFor(-250));
corrupt[corrupt.length - 1] ^= 0xff;
assert.throws(() => parseModbusReadResponse(corrupt), /CRC mismatch/);
console.log('ok - Cworth CE-H6K wired BMS profile and Modbus decoding');
