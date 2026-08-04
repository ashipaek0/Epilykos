/**
 * Plain Modbus TCP Transport — TCP client for polling inverters with standard Modbus TCP.
 *
 * Used for Sofar LSE-3 (port 8899), Voltronic/Axpert (port 502), and any inverter
 * that speaks plain Modbus TCP without a proprietary wrapper protocol.
 *
 * Opens a fresh TCP connection per poll.
 *
 * @module dongle/modbusTcp
 */
const net = require('net');

class ModbusTcpTransport {
  /**
   * @param {object} instance — dongle config { host, port, modbus_unit_id }
   */
  constructor(instance) {
    this.host = instance.host;
    this.port = instance.port || 502;
    this.unitId = instance.modbus_unit_id || 1;
    this.txId = 1;
  }

  /**
   * Read holding registers from the device.
   * @param {number} startAddr — register address (decimal)
   * @param {number} count — number of registers
   * @returns {Promise<Buffer>} register data (2 bytes per register)
   */
  readRegisters(startAddr, count) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);

      socket.connect(this.port, this.host, () => {
        const pdu = Buffer.alloc(5);
        pdu[0] = 0x03;
        pdu.writeUInt16BE(startAddr, 1);
        pdu.writeUInt16BE(count, 3);

        const frame = Buffer.alloc(7 + pdu.length);
        frame.writeUInt16BE(this.txId++, 0);
        frame.writeUInt16BE(0x0000, 2);
        frame.writeUInt16BE(pdu.length + 1, 4);
        frame[6] = this.unitId;
        pdu.copy(frame, 7);

        socket.write(frame);
      });

      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= 7) {
          const pduLen = buffer.readUInt16BE(4) - 1;
          const totalLen = 7 + pduLen;
          if (buffer.length >= totalLen) {
            clearTimeout(timeout);
            socket.destroy();
            try {
              const pdu = buffer.slice(8, totalLen);
              if (pdu[0] & 0x80) { reject(new Error(`Modbus exception ${pdu[1]}`)); return; }
              const byteCount = pdu[1];
              resolve(pdu.slice(2, 2 + byteCount));
            } catch (e) { reject(e); }
          }
        }
      });

      socket.on('error', err => { clearTimeout(timeout); reject(err); });
    });
  }

  /**
   * Write a single holding register to the device (Modbus FC 0x06).
   * @param {number} startAddr — register address (decimal)
   * @param {number} value — 16-bit value to write
   * @returns {Promise<void>}
   */
  writeRegister(startAddr, value) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);

      socket.connect(this.port, this.host, () => {
        const pdu = Buffer.alloc(5);
        pdu[0] = 0x06; // Write Single Register
        pdu.writeUInt16BE(startAddr, 1);
        pdu.writeUInt16BE(value & 0xFFFF, 3);

        const frame = Buffer.alloc(7 + pdu.length);
        frame.writeUInt16BE(this.txId++, 0);
        frame.writeUInt16BE(0x0000, 2);
        frame.writeUInt16BE(pdu.length + 1, 4);
        frame[6] = this.unitId;
        pdu.copy(frame, 7);

        socket.write(frame);
      });

      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= 7) {
          const pduLen = buffer.readUInt16BE(4) - 1;
          const totalLen = 7 + pduLen;
          if (buffer.length >= totalLen) {
            clearTimeout(timeout);
            socket.destroy();
            try {
              const pdu = buffer.slice(8, totalLen);
              if (pdu[0] & 0x80) { reject(new Error(`Modbus exception ${pdu[1]}`)); return; }
              resolve();
            } catch (e) { reject(e); }
          }
        }
      });

      socket.on('error', err => { clearTimeout(timeout); reject(err); });
    });
  }
}

/**
 * Standalone helper: write a single holding register to a Modbus TCP device.
 * @param {string} host — device host or IP
 * @param {number} port — TCP port (default 502)
 * @param {number} register — register address (decimal)
 * @param {number} value — 16-bit value to write
 * @param {number} [unitId] — Modbus unit/slave ID (default 1)
 * @returns {Promise<void>}
 */
async function writeRegister(host, port, register, value, unitId) {
  const transport = new ModbusTcpTransport({
    host,
    port: parseInt(port) || 502,
    modbus_unit_id: unitId || 1
  });
  await transport.writeRegister(parseInt(register), parseInt(value) || 0);
}

module.exports = { ModbusTcpTransport, writeRegister };
