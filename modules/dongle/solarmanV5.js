/**
 * Solarman V5 Transport — TCP client for polling inverter WiFi dongles.
 *
 * Protocol: proprietary Solarman V5 framing around Modbus RTU payloads.
 * Port: 8899 (default). Requires logger serial number for authentication.
 *
 * Opens a fresh TCP connection per poll — dongles are unstable with persistent connections.
 *
 * @module dongle/solarmanV5
 */
const net = require('net');
const { buildModbusReadRequest, parseModbusReadResponse } = require('./crc');

class SolarmanV5Transport {
  /**
   * @param {object} instance — dongle config { host, port, serial_number, modbus_unit_id }
   */
  constructor(instance) {
    this.host = instance.host;
    this.port = instance.port || 8899;
    this.serial = Buffer.alloc(4);
    this.serial.writeUInt32LE(parseInt(instance.serial_number), 0);
    this.unitId = instance.modbus_unit_id || 1;
    this.seqByte = Math.floor(Math.random() * 256);
  }

  /**
   * Read holding registers from the dongle.
   * @param {number} startAddr — register address (decimal)
   * @param {number} count — number of registers
   * @returns {Promise<Buffer>} register data (2 bytes per register)
   */
  readRegisters(startAddr, count) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let responseBuffer = Buffer.alloc(0);
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 8000);

      socket.connect(this.port, this.host, () => {
        const modbusFrame = buildModbusReadRequest(this.unitId, 3, startAddr, count);
        const v5Frame = this._buildV5Frame(modbusFrame);
        socket.write(v5Frame);
      });

      socket.on('data', (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        if (responseBuffer.length >= 13 && responseBuffer[responseBuffer.length - 1] === 0x15) {
          clearTimeout(timeout);
          socket.destroy();
          try { resolve(this._parseV5Response(responseBuffer)); }
          catch (e) { reject(e); }
        }
      });

      socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  /** Wrap a Modbus RTU frame in a Solarman V5 frame */
  _buildV5Frame(modbusRtuFrame) {
    const payloadLen = 15 + modbusRtuFrame.length;
    const buf = Buffer.alloc(11 + payloadLen + 2);

    buf[0] = 0xA5;
    buf.writeUInt16LE(payloadLen, 1);
    buf.writeUInt16LE(0x4510, 3);
    buf.writeUInt8(this.seqByte, 5);
    buf.writeUInt8(0x00, 6);
    this.serial.copy(buf, 7);

    buf[11] = 0x02;              // frame type (inverter)
    buf.writeUInt16LE(0, 12);    // sensor type
    buf.writeUInt32LE(0, 14);    // working time
    buf.writeUInt32LE(0, 18);    // power on time
    buf.writeUInt32LE(0, 22);    // offset time

    modbusRtuFrame.copy(buf, 26);

    buf[buf.length - 2] = this._v5Checksum(buf);
    buf[buf.length - 1] = 0x15;

    this.seqByte = (this.seqByte + 1) & 0xFF;
    return buf;
  }

  /** Parse Solarman V5 response, extract Modbus RTU payload */
  _parseV5Response(buf) {
    if (buf[0] !== 0xA5) throw new Error('missing start marker');
    if (buf[buf.length - 1] !== 0x15) throw new Error('missing end marker');
    const expected = this._v5Checksum(buf);
    if (buf[buf.length - 2] !== expected) throw new Error('checksum mismatch');

    const controlCode = buf.readUInt16LE(3);
    if (controlCode !== 0x1510) throw new Error(`unexpected control code: 0x${controlCode.toString(16)}`);

    const payloadLen = buf.readUInt16LE(1);
    const modbusStart = 25;
    const modbusEnd = 11 + payloadLen;
    let modbusData = buf.slice(modbusStart, modbusEnd);

    // Detect and strip Deye double-CRC (two spurious 0x00 bytes appended after valid CRC)
    if (modbusData.length > 5 && modbusData[modbusData.length - 1] === 0x00 && modbusData[modbusData.length - 2] === 0x00) {
      modbusData = modbusData.slice(0, -2);
    }

    return parseModbusReadResponse(modbusData);
  }

  /** Solarman V5 checksum: XOR sum of bytes 0x01 to end (excl start, checksum, end marker) */
  _v5Checksum(buf) {
    let sum = 0;
    for (let i = 1; i < buf.length - 2; i++) sum = (sum + buf[i]) & 0xFF;
    return sum;
  }
}

module.exports = { SolarmanV5Transport };
