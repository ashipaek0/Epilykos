/**
 * Plain Modbus RTU Transport — serial client for polling inverters with standard Modbus RTU.
 * Used for Anern/PowMr/Voltronic-family inverters that expose native Modbus RTU over
 * RS232/RS485/USB (e.g. AN-SCI-EVO4200L, 2400 baud, slave ID 5).
 * Opens a fresh serial connection per poll (mirrors ModbusTcpTransport).
 * @module dongle/modbusRtu
 */
const { SerialPort } = require('serialport');
const {
  buildModbusReadRequest,
  parseModbusReadResponse,
  buildModbusWriteRequest,
  parseModbusWriteResponse,
} = require('./crc');

class ModbusRtuTransport {
  constructor(instance) {
    this.serialPath = instance.serial_path;
    this.baud = parseInt(instance.baud) || 2400;
    this.unitId = instance.modbus_unit_id || 5;
  }

  _open() {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: this.serialPath,
        baudRate: this.baud,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      });
      port.once('open', () => resolve(port));
      port.once('error', err => reject(err));
    });
  }

  _request(frame) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: this.serialPath,
        baudRate: this.baud,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      });
      let buf = Buffer.alloc(0);
      const timeout = setTimeout(() => { try { port.close(); } catch (_) {} reject(new Error('timeout')); }, 5000);
      const onError = err => { clearTimeout(timeout); try { port.close(); } catch (_) {} reject(err); };
      port.once('open', () => {
        port.once('error', onError);
        port.on('data', d => {
          buf = Buffer.concat([buf, d]);
          const byteCount = buf.length >= 3 ? buf[2] : 0;
          const total = 3 + byteCount + 2;
          if (buf.length >= total && byteCount > 0) {
            clearTimeout(timeout);
            try { port.close(); } catch (_) {}
            resolve(buf);
          }
        });
        port.write(frame, err => { if (err) onError(err); });
      });
      port.once('error', onError);
    });
  }

  async readRegisters(startAddr, count) {
    // Frame: FC 0x03, addr, count (for a count of registers -> byteCount = count*2)
    const frame = Buffer.alloc(8);
    frame[0] = this.unitId; frame[1] = 0x03;
    frame.writeUInt16BE(startAddr, 2);
    frame.writeUInt16BE(count, 4);
    // CRC appended by buildModbusReadRequest:
    const { modbusCrc16 } = require('./crc');
    const crc = modbusCrc16(frame.slice(0, 6));
    frame.writeUInt16LE(crc, 6);
    const resp = await this._request(frame);
    return parseModbusReadResponse(resp);
  }

  async writeRegister(startAddr, value) {
    const frame = buildModbusWriteRequest(this.unitId, startAddr, value);
    const resp = await this._request(frame);
    parseModbusWriteResponse(resp);
  }
}

module.exports = { ModbusRtuTransport };
