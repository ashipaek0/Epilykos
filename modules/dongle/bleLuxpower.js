/**
 * LuxPower Bluetooth Transport — the LuxPower v5 "TranslatedData" protocol
 * (see ./luxpowerTcp.js) carried over the dongle's Bluetooth link instead of
 * TCP port 8000.
 *
 * LuxPower Wi-Fi dongles with Bluetooth (ESP32-based, advertised under the
 * dongle serial, e.g. "DT62000575") expose one vendor service 0x00FF with one
 * characteristic 0xFF01 [read, write, notify]. The request frame — byte for
 * byte the one sent over TCP — is written to FF01 (a BlueZ long write, since
 * it exceeds the 20-byte default payload) and the response is notified back on
 * FF01 in 20-byte pieces. The response carries a zeroed dongle serial in its
 * outer header; the inner payload (dev_fn, inverter serial, start, values) is
 * identical to TCP. The dongle also pushes unsolicited frames on FF01; the
 * Bluetooth helper skips those and returns only the frame that answers the
 * request.
 *
 * Same interface as LuxpowerTcpTransport (start / stop / readRegisters /
 * writeRegister), so modules/dongle.js polls, decodes and writes through the
 * existing luxpower-tcp profiles unchanged. Requests are serialized by the
 * shared Bluetooth helper.
 *
 * Instance config:
 *   ble_address      — dongle MAC (falls back to host)
 *   dongle_serial    — 10-char dongle serial (outer header of requests)
 *   inverter_serial  — 10-char inverter serial
 *   ble_write_uuid / ble_notify_uuid — override FF01 when a dongle differs
 *
 * @module dongle/bleLuxpower
 */
const ble = require('../ble');
const { normalizeUuid } = require('./bleModbus');
const {
  buildReadFrame, buildWriteFrame, parseFrame, crc16Modbus,
  DEV_FN_HOLDING, DEV_FN_WRITE_SINGLE
} = require('./luxpowerTcp');

const DEFAULT_CHAR_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';

class BleLuxpowerTransport {
  /**
   * @param {object} instance — dongle config (see module doc)
   * @param {object} [deps] — { exchange } override for tests
   */
  constructor(instance, deps = {}) {
    const address = String(instance.ble_address || instance.host || '').trim().toUpperCase();
    if (!ble.isValidAddress(address)) throw new Error(`invalid Bluetooth address "${instance.ble_address || instance.host || ''}"`);
    this.address = address;
    this.writeUuid = normalizeUuid(instance.ble_write_uuid || DEFAULT_CHAR_UUID);
    this.notifyUuid = normalizeUuid(instance.ble_notify_uuid || DEFAULT_CHAR_UUID);
    if (!this.writeUuid) throw new Error(`invalid write characteristic UUID "${instance.ble_write_uuid}"`);
    if (!this.notifyUuid) throw new Error(`invalid notify characteristic UUID "${instance.ble_notify_uuid}"`);
    this.dongle = instance.dongle_serial;
    this.inverter = instance.inverter_serial;
    this.protocol = (instance.protocol === undefined ? 5 : parseInt(instance.protocol, 10)) || 5;
    // Validates both serials now so a bad config fails at startup, not per poll.
    buildReadFrame({ protocol: this.protocol, dongle: this.dongle, inverter: this.inverter, devFn: DEV_FN_HOLDING, start: 0, count: 1 });
    this.exchange = deps.exchange || ble.luxpowerExchange;
  }

  /** Nothing to open — the Bluetooth helper connects on demand and keeps the link. */
  start() { return this; }

  stop() {}

  async _request(frame) {
    const resp = await this.exchange(this.address, { writeUuid: this.writeUuid, notifyUuid: this.notifyUuid, frame });
    if (resp.length < 22) throw new Error('response too short');
    const stored = resp.readUInt16LE(resp.length - 2);
    const computed = crc16Modbus(resp.slice(20, resp.length - 2));
    if (stored !== computed) throw new Error(`CRC mismatch (stored 0x${stored.toString(16)}, computed 0x${computed.toString(16)})`);
    const parsed = parseFrame(resp);
    if (parsed.inverter !== this.inverter) throw new Error(`response from inverter ${parsed.inverter}, expected ${this.inverter}`);
    return parsed;
  }

  /**
   * @param {number} start — register address (decimal)
   * @param {number} count — number of registers
   * @param {number} [devFn] — 0x03 holding (default) or 0x04 input
   * @returns {Promise<Buffer>} raw value bytes (2 bytes per register, as received)
   */
  async readRegisters(start, count, devFn = DEV_FN_HOLDING) {
    const frame = buildReadFrame({ protocol: this.protocol, dongle: this.dongle, inverter: this.inverter, devFn, start, count });
    const parsed = await this._request(frame);
    if (parsed.byteLen !== count * 2) throw new Error(`expected ${count} registers, got ${parsed.byteLen / 2}`);
    return parsed.values;
  }

  /**
   * Write one holding register (write-single); resolves with the 2-byte echo.
   */
  async writeRegister(start, value) {
    const frame = buildWriteFrame({ protocol: this.protocol, dongle: this.dongle, inverter: this.inverter, start, value });
    const parsed = await this._request(frame);
    if (parsed.devFn !== DEV_FN_WRITE_SINGLE || parsed.start !== start) throw new Error('write echo mismatch');
    return parsed.values;
  }
}

module.exports = { BleLuxpowerTransport, DEFAULT_CHAR_UUID };
