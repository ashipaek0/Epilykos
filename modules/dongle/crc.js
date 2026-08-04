/**
 * Shared CRC and Modbus frame utilities for dongle transports.
 * @module dongle/crc
 */

/** Modbus CRC-16 (polynomial 0xA001) */
function modbusCrc16(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) crc = (crc >> 1) ^ 0xA001;
      else crc >>= 1;
    }
  }
  return crc;
}

/** Build a Modbus RTU read holding registers request frame with CRC */
function buildModbusReadRequest(unitId, funcCode, startAddr, count) {
  const buf = Buffer.alloc(8);
  buf[0] = unitId;
  buf[1] = funcCode;
  buf.writeUInt16BE(startAddr, 2);
  buf.writeUInt16BE(count, 4);
  const crc = modbusCrc16(buf.slice(0, 6));
  buf.writeUInt16LE(crc, 6);
  return buf;
}

/** Build a Modbus RTU write single register request frame with CRC (FC 0x06) */
function buildModbusWriteRequest(unitId, startAddr, value) {
  const buf = Buffer.alloc(8);
  buf[0] = unitId;
  buf[1] = 0x06;
  buf.writeUInt16BE(startAddr, 2);
  buf.writeUInt16BE(value & 0xFFFF, 4);
  const crc = modbusCrc16(buf.slice(0, 6));
  buf.writeUInt16LE(crc, 6);
  return buf;
}

/**
 * Parse a Modbus RTU read response.
 * @returns {Buffer} register data (2 bytes per register)
 * @throws on exception code, CRC mismatch, or incomplete response
 */
function parseModbusReadResponse(buf) {
  if (buf.length < 5) throw new Error('response too short');
  if (buf[1] & 0x80) throw new Error(`Modbus exception ${buf[2]}`);
  const byteCount = buf[2];
  if (buf.length < 5 + byteCount) throw new Error('incomplete response');
  const expectedCrc = modbusCrc16(buf.slice(0, 3 + byteCount));
  const actualCrc = buf.readUInt16LE(3 + byteCount);
  if (expectedCrc !== actualCrc) throw new Error('CRC mismatch');
  return buf.slice(3, 3 + byteCount);
}

/**
 * Parse a Modbus RTU write single register response.
 * @returns {{address: number, value: number}}
 * @throws on exception code, CRC mismatch, or incomplete response
 */
function parseModbusWriteResponse(buf) {
  if (buf.length < 8) throw new Error('response too short');
  if (buf[1] & 0x80) throw new Error(`Modbus exception ${buf[2]}`);
  const expectedCrc = modbusCrc16(buf.slice(0, 6));
  const actualCrc = buf.readUInt16LE(6);
  if (expectedCrc !== actualCrc) throw new Error('CRC mismatch');
  return { address: buf.readUInt16BE(2), value: buf.readUInt16BE(4) };
}

module.exports = { modbusCrc16, buildModbusReadRequest, parseModbusReadResponse, buildModbusWriteRequest, parseModbusWriteResponse };
