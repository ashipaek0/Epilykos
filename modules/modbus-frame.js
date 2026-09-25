/**
 * Shared Modbus frame + CRC16 helpers.
 *
 * This is the single home for Modbus RTU framing/CRC utilities used by BOTH the
 * dongle transports (modbusTcp, solarmanV5) and the RS232 serial engine. It is
 * intentionally top-level (modules/) so the serial engine never has to import
 * from modules/dongle/.
 *
 * @module modbus-frame
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

/** Build a Modbus RTU read holding registers request frame (FC 0x03) with CRC */
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

/** Build a Modbus RTU write single register request frame (FC 0x06) with CRC */
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
 * Total Modbus-RTU frame length for a (partial) response buffer.
 * Layout: slave(1) + func(1) + byteCount(1) + data(byteCount) + crcLo(1) + crcHi(1).
 * Returns 3 + buf[2] + 2.
 */
function frameByteCount(buf) {
  return 3 + buf[2] + 2;
}

/**
 * Parse a Modbus RTU read response.
 * @param {Buffer} buf — a complete frame read off the wire (may be sliced).
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

/**
 * Group a list of register metrics ([{register: '0x1196', count: 1|2}] with
 * registers as hex strings) into contiguous poll ranges. Registers within a
 * gap of 4 (plus their own count) are merged; otherwise a new range starts.
 * @param {Array<{register: string, count?: number}>} metrics
 * @returns {Array<{start: number, count: number}>}
 */
function buildPollRanges(metrics) {
  const addresses = metrics
    .map(m => ({ addr: parseInt(m.register, 16), count: m.count || 1 }))
    .sort((a, b) => a.addr - b.addr);

  const ranges = [];
  for (const item of addresses) {
    const last = ranges[ranges.length - 1];
    if (last && item.addr <= last.start + last.count + 4) {
      const newEnd = Math.max(last.start + last.count, item.addr + item.count);
      last.count = newEnd - last.start;
    } else {
      ranges.push({ start: item.addr, count: item.count });
    }
  }
  return ranges;
}

module.exports = {
  modbusCrc16,
  buildModbusReadRequest,
  buildModbusWriteRequest,
  parseModbusReadResponse,
  parseModbusWriteResponse,
  frameByteCount,
  buildPollRanges,
};
