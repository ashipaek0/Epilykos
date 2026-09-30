/**
 * Bluetooth GATT-read Transport — devices that publish their live values in
 * readable GATT characteristics instead of answering commands.
 *
 * The Phocos Any-Grid (Voltronic) display is one: the QPIGS/QPIRI results sit
 * in fixed 20-byte characteristics as little-endian 16-bit words, filed under
 * reused standard UUIDs (e.g. "Blood Pressure" 0x1810). Monitoring is therefore
 * a handful of reads — nothing is ever written to the device.
 *
 * The profile describes the reads and how to lay them out:
 *   "blocks":  [{ "id": "live", "service": "1810", "characteristic": "2a03" }, ...]
 *   "derived": [{ "name": "pv_power", "sum": ["pv1[7]", "pv2[7]"] },
 *               { "name": "battery_discharge_power", "product": ["live[8]", "status[2]"] }]
 * (derived values are raw word arithmetic; the field's scale converts units)
 * poll() returns { live: [w0, w1, ...], pv1: [...], derived: { pv_power } } so
 * profile.fields address values by path ("live[5]"), exactly like the
 * felicity-tcp JSON family, and dongle.js pollJsonInstance does the rest.
 *
 * @module dongle/bleGatt
 */
const ble = require('../ble');

/** Little-endian 16-bit words of a characteristic value. */
function wordsLE(buf) {
  const out = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readUInt16LE(i));
  return out;
}

/** 'pv1[7]' → data.pv1[7]; undefined when missing. */
function valueAt(data, ref) {
  const m = /^([A-Za-z0-9_]+)\[(\d+)\]$/.exec(String(ref));
  if (!m || !Array.isArray(data[m[1]])) return undefined;
  return data[m[1]][Number(m[2])];
}

/** Pure decode of the raw reads (Buffer|null per block) — exported for tests. */
function decodeBlocks(profile, raws) {
  const data = {};
  (profile.blocks || []).forEach((b, i) => {
    if (raws[i]) data[b.id] = wordsLE(raws[i]);
  });
  const derived = {};
  for (const d of profile.derived || []) {
    const refs = Array.isArray(d.sum) ? d.sum : Array.isArray(d.product) ? d.product : null;
    if (!refs) continue;
    const parts = refs.map(ref => valueAt(data, ref));
    if (!parts.every(v => typeof v === 'number')) continue;
    derived[d.name] = d.sum ? parts.reduce((a, v) => a + v, 0) : parts.reduce((a, v) => a * v, 1);
  }
  data.derived = derived;
  return data;
}

class BleGattTransport {
  /**
   * @param {object} instance — dongle config (ble_address or host = MAC)
   * @param {object} profile — profile with blocks[] (and optional derived[])
   * @param {object} [deps] — { read } override for tests
   */
  constructor(instance, profile, deps = {}) {
    const address = String(instance.ble_address || instance.host || '').trim().toUpperCase();
    if (!ble.isValidAddress(address)) throw new Error(`invalid Bluetooth address "${instance.ble_address || instance.host || ''}"`);
    if (!profile || !Array.isArray(profile.blocks) || !profile.blocks.length) throw new Error('profile has no Bluetooth blocks');
    this.address = address;
    this.profile = profile;
    this.read = deps.read || ble.gattRead;
  }

  async poll() {
    const reads = this.profile.blocks.map(b => ({ service: b.service, characteristic: b.characteristic }));
    const raws = await this.read(this.address, reads);
    const data = decodeBlocks(this.profile, raws);
    if (!this.profile.blocks.some(b => Array.isArray(data[b.id]))) throw new Error('no data read from device');
    return data;
  }
}

module.exports = { BleGattTransport, decodeBlocks, wordsLE };
