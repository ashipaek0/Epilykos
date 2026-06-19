/**
 * Test SolaX AA55 binary frame encode/decode with checksum verification.
 * Run: /usr/bin/node tests/test-rs232-solax.js
 */
const assert = require('assert');

// Copy of additiveChecksum16LE from rs232-utils
function additiveChecksum16LE(data) {
  let sum = 0;
  for (const byte of data) {
    sum = (sum + byte) & 0xFFFF;
  }
  return sum;
}

// Copy of the encode function from solax-decoder.js
function encodeQuery(cmd) {
  const func = cmd.function || 0x01;
  const ctrl = cmd.control || 0x01;
  const payloadStr = cmd.payload || '';
  const payload = Buffer.from(payloadStr, 'ascii');
  const body = Buffer.concat([
    Buffer.from([0xAA, 0x55]),
    Buffer.alloc(1),
    Buffer.from([ctrl, func]),
    payload,
  ]);
  body[2] = 2 + payload.length;
  const checksum = additiveChecksum16LE(body.slice(2));
  return Buffer.concat([body, Buffer.from([checksum & 0xFF, (checksum >> 8) & 0xFF])]);
}

// Copy of decodeResponse from solax-decoder.js
function decodeResponse(buffer, profile) {
  if (buffer.length < 7) throw new Error('Too short');
  if (buffer[0] !== 0xAA || buffer[1] !== 0x55) throw new Error('Bad header');
  const bodyEnd = buffer.length - 2;
  const expectedChk = additiveChecksum16LE(buffer.slice(2, bodyEnd));
  const actualChk = buffer.readUInt16LE(bodyEnd);
  if (expectedChk !== actualChk) throw new Error('Checksum mismatch');
  const payloadOffset = 5;
  const payloadData = buffer.slice(payloadOffset, bodyEnd);
  const results = {};
  for (const field of profile.fields || []) {
    if (field.offset + 2 > payloadData.length) continue;
    let raw;
    if (field.type === 'uint16') raw = payloadData.readUInt16LE(field.offset);
    else if (field.type === 'int16') raw = payloadData.readInt16LE(field.offset);
    else if (field.type === 'uint32') { if (field.offset + 4 > payloadData.length) continue; raw = payloadData.readUInt32LE(field.offset); }
    else raw = payloadData.readUInt16LE(field.offset);
    results[field.metric] = parseFloat((raw * (field.scale || 1)).toFixed(4));
  }
  return results;
}

// Test 1: Encode register dongle frame
const regCmd = { name: 'register_dongle', function: 1, control: 2, payload: 'TEST' };
const frame = encodeQuery(regCmd);
assert.strictEqual(frame[0], 0xAA, 'Header AA');
assert.strictEqual(frame[1], 0x55, 'Header 55');
assert.strictEqual(frame[2], 6, 'Size (2 + 4 byte payload)');
assert.strictEqual(frame[3], 2, 'Control');
assert.strictEqual(frame[4], 1, 'Function');
assert.strictEqual(frame.toString('ascii', 5, 9), 'TEST', 'Payload');
// Verify checksum
const chk = additiveChecksum16LE(frame.slice(2, frame.length - 2));
assert.strictEqual(chk, frame.readUInt16LE(frame.length - 2), 'Checksum valid');
console.log('✓ SolaX Test 1: Register frame encodes correctly');

// Test 2: Encode request data frame and decode response
const dataCmd = { name: 'request_data', function: 12, control: 1 };
const queryFrame = encodeQuery(dataCmd);

// Build a simulated response frame with known values
const profile = {
  fields: [
    { metric: 'grid_voltage', offset: 0, type: 'uint16', scale: 0.1 },
    { metric: 'battery_soc',  offset: 14, type: 'uint16', scale: 1.0 },
    { metric: 'energy_total', offset: 18, type: 'uint32', scale: 0.1 },
  ],
};

// Response: AA 55 [size=0x10] [ctrl=0x01] [func=0x0C] [payload 16 bytes] [chk]
const payload = Buffer.alloc(26);
payload.writeUInt16LE(2400, 0);   // grid_voltage = 240.0V (2400 * 0.1)
payload.writeUInt16LE(85, 14);    // battery_soc = 85% (85 * 1.0)
payload.writeUInt32LE(12345, 18); // energy_total = 1234.5 kWh (12345 * 0.1)

const respBody = Buffer.concat([
  Buffer.from([0xAA, 0x55, 0x1C, 0x01, 0x0C]), // header
  payload,
]);
const respChk = additiveChecksum16LE(respBody.slice(2));
const response = Buffer.concat([respBody, Buffer.from([respChk & 0xFF, (respChk >> 8) & 0xFF])]);

const decoded = decodeResponse(response, profile);
assert.strictEqual(Math.round(decoded.grid_voltage * 10) / 10, 240.0, 'grid_voltage');
assert.strictEqual(decoded.battery_soc, 85, 'battery_soc');
assert.strictEqual(Math.round(decoded.energy_total * 10) / 10, 1234.5, 'energy_total');

console.log('✓ SolaX Test 2: Request data encodes and decodes correctly');
console.log('  Decoded:', decoded);

// Test 3: Checksum mismatch detection
const badResponse = Buffer.from(response); // copy
badResponse[badResponse.length - 1] ^= 0xFF; // corrupt checksum
try {
  decodeResponse(badResponse, profile);
  console.error('✗ SolaX Test 3: Should have thrown on bad checksum');
  process.exit(1);
} catch (e) {
  console.log('✓ SolaX Test 3: Bad checksum correctly rejected');
}

console.log('\n✓ All SolaX tests passed');
