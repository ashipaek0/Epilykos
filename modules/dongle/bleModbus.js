/**
 * Bluetooth Modbus Transport — Modbus-RTU frames over a BLE GATT write/notify
 * characteristic pair.
 *
 * Many inverter Bluetooth modules (e.g. SRNE / Renogy-style BT modules) tunnel
 * plain Modbus-RTU over BLE: the request is written to one characteristic and
 * the response arrives as notifications on another. This transport builds and
 * checks the frames with modules/modbus-frame.js and hands the bytes to the
 * shared Bluetooth helper (modules/ble.js), so any register-based dongle
 * profile can be polled over Bluetooth.
 *
 * Instance config:
 *   ble_address      — device MAC (falls back to host)
 *   ble_write_uuid   — characteristic the request is written to
 *   ble_notify_uuid  — characteristic the response is notified on
 *   modbus_unit_id   — Modbus slave id (default 1)
 *
 * @module dongle/bleModbus
 */
const ble = require('../ble');
const {
  buildModbusReadRequest,
  buildModbusWriteRequest,
  parseModbusReadResponse,
  parseModbusWriteResponse
} = require('../modbus-frame');

// Defaults used by the common FFD0/FFF0 Modbus-over-BLE modules. Instances
// override them when their module uses different characteristics.
const DEFAULT_WRITE_UUID = '0000ffd1-0000-1000-8000-00805f9b34fb';
const DEFAULT_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';

const UUID_RE = /^([0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Expand 16/32-bit short UUIDs to the Bluetooth base UUID. */
function normalizeUuid(uuid) {
  const u = String(uuid || '').trim().toLowerCase();
  if (!UUID_RE.test(u)) return null;
  if (u.length === 4) return `0000${u}-0000-1000-8000-00805f9b34fb`;
  if (u.length === 8) return `${u}-0000-1000-8000-00805f9b34fb`;
  return u;
}

class BleModbusTransport {
  /**
   * @param {object} instance — dongle config (see module doc)
   * @param {object} [deps] — { exchange } override for tests
   */
  constructor(instance, deps = {}) {
    const address = String(instance.ble_address || instance.host || '').trim().toUpperCase();
    if (!ble.isValidAddress(address)) throw new Error(`invalid Bluetooth address "${instance.ble_address || instance.host || ''}"`);
    this.address = address;
    this.writeUuid = normalizeUuid(instance.ble_write_uuid || DEFAULT_WRITE_UUID);
    this.notifyUuid = normalizeUuid(instance.ble_notify_uuid || DEFAULT_NOTIFY_UUID);
    if (!this.writeUuid) throw new Error(`invalid write characteristic UUID "${instance.ble_write_uuid}"`);
    if (!this.notifyUuid) throw new Error(`invalid notify characteristic UUID "${instance.ble_notify_uuid}"`);
    this.unitId = parseInt(instance.modbus_unit_id, 10) || 1;
    this.functionCode = parseInt(instance.function_code, 10) === 4 ? 0x04 : 0x03;
    this.exchange = deps.exchange || ble.modbusExchange;
  }

  _send(frame) {
    return this.exchange(this.address, { writeUuid: this.writeUuid, notifyUuid: this.notifyUuid, frame });
  }

  /**
   * Read registers from the device.
   * @param {number} startAddr — register address (decimal)
   * @param {number} count — number of registers
   * @returns {Promise<Buffer>} register data (2 bytes per register)
   */
  async readRegisters(startAddr, count) {
    const resp = await this._send(buildModbusReadRequest(this.unitId, this.functionCode, startAddr, count));
    if (resp[0] !== this.unitId) throw new Error(`unexpected unit id ${resp[0]} in response`);
    return parseModbusReadResponse(resp);
  }

  /**
   * Write a single holding register (Modbus FC 0x06).
   * @param {number} startAddr — register address (decimal)
   * @param {number} value — 16-bit value to write
   * @returns {Promise<void>}
   */
  async writeRegister(startAddr, value) {
    const resp = await this._send(buildModbusWriteRequest(this.unitId, startAddr, value));
    const echo = parseModbusWriteResponse(resp);
    if (echo.address !== startAddr) throw new Error(`write echo mismatch (register ${echo.address})`);
  }
}

module.exports = { BleModbusTransport, normalizeUuid, DEFAULT_WRITE_UUID, DEFAULT_NOTIFY_UUID };
