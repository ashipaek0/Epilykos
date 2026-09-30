/**
 * JK-BMS (Jikong) wired protocol — the "4E 57" RS485 / GPS-port protocol of
 * the JK-B / JK-BD families (RS485 adapter or UART), 115200 8N1.
 *
 * Request (read all, 21 bytes):
 *   4E 57 | 00 13 | 00 00 00 00 | 06 | 03 | 00 | 00 | 00 00 00 00 | 68 | 00 00 | chk_hi chk_lo
 *   header  length  terminal      cmd   src  type reg   record        end  (unused)
 * Checksum: sum of every byte before it (16-bit, big-endian in the last two
 * bytes; the two bytes before it are 0). The length field counts the frame
 * from itself onwards, so a frame is (length + 2) bytes long.
 *
 * Response data (from byte 11 to length − 7) is a run of <id><value> pairs:
 * 0x79 carries a byte count then 3 bytes per cell (index + mV), the rest have
 * fixed sizes (ID_SIZES). Values are big-endian. Parsing walks the ids, so it
 * does not depend on a fixed firmware layout.
 *
 * Sources: syssi/esphome-jk-bms (jk_modbus.cpp, jk_bms.cpp) and
 * jblance/mpp-solar (protocols/jkserial.py). Output keys match aiobmsble.
 *
 * @module bms-decoders/jk
 */
'use strict';

// Value size in bytes for each identifier after 0x79.
const ID_SIZES = {
  0x80: 2, 0x81: 2, 0x82: 2, 0x83: 2, 0x84: 2, 0x85: 1, 0x86: 1, 0x87: 2, 0x89: 4,
  0x8A: 2, 0x8B: 2, 0x8C: 2, 0x8E: 2, 0x8F: 2, 0x90: 2, 0x91: 2, 0x92: 2, 0x93: 2,
  0x94: 2, 0x95: 2, 0x96: 2, 0x97: 2, 0x98: 2, 0x99: 2, 0x9A: 2, 0x9B: 2, 0x9C: 2,
  0x9D: 1, 0x9E: 2, 0x9F: 2, 0xA0: 2, 0xA1: 2, 0xA2: 2, 0xA3: 2, 0xA4: 2, 0xA5: 2,
  0xA6: 2, 0xA7: 2, 0xA8: 2, 0xA9: 1, 0xAA: 4, 0xAB: 1, 0xAC: 1, 0xAD: 2, 0xAE: 1,
  0xAF: 1, 0xB0: 2, 0xB1: 1, 0xB2: 10, 0xB3: 1, 0xB4: 8, 0xB5: 4, 0xB6: 4, 0xB7: 15,
  0xB8: 1, 0xB9: 4, 0xBA: 24, 0xC0: 1
};

function sum16(bytes) {
  let s = 0;
  for (const b of bytes) s += b;
  return s & 0xFFFF;
}

/** Read-all request. */
function buildRequest() {
  const f = Buffer.from([0x4E, 0x57, 0x00, 0x13, 0, 0, 0, 0, 0x06, 0x03, 0x00, 0x00, 0, 0, 0, 0, 0x68, 0, 0, 0, 0]);
  f.writeUInt16BE(sum16(f.subarray(0, 19)), 19);
  return f;
}

/** Bytes needed for the frame at the start of buf, or null while incomplete. */
function frameLength(buf) {
  if (buf.length < 4) return null;
  return buf.readUInt16BE(2) + 2;
}

/** Drop bytes before the first 4E 57. */
function sync(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x4E && buf[i + 1] === 0x57) return buf.subarray(i);
  }
  return buf.length && buf[buf.length - 1] === 0x4E ? buf.subarray(buf.length - 1) : Buffer.alloc(0);
}

/** Validate a complete frame → data payload (Buffer). Throws on error. */
function parseFrame(frame) {
  if (frame.length < 20 || frame[0] !== 0x4E || frame[1] !== 0x57) throw new Error('JK: bad frame header');
  const len = frame.readUInt16BE(2);
  if (frame.length < len + 2) throw new Error('JK: frame too short');
  const want = sum16(frame.subarray(0, len));
  const got = frame.readUInt16BE(len);
  if (want !== got) throw new Error('JK: checksum mismatch');
  return frame.subarray(11, len - 7);
}

/** Walk <id><value> pairs → { id: Buffer }. Stops at an unknown id. */
function splitIds(payload) {
  const out = {};
  let i = 0;
  while (i < payload.length) {
    const id = payload[i];
    if (id === 0x79) {
      const n = payload[i + 1];
      out[0x79] = payload.subarray(i + 2, i + 2 + n);
      i += 2 + n;
      continue;
    }
    const size = ID_SIZES[id];
    if (!size || i + 1 + size > payload.length) break;
    out[id] = payload.subarray(i + 1, i + 1 + size);
    i += 1 + size;
  }
  return out;
}

/** 0–99 °C as is; 100+ encodes negatives (101 = −1 °C, 140 = −40 °C). */
function temperature(v) {
  return v > 99 ? 99 - v : v;
}

/** Bit 15 set = charging (+), clear = discharging (−); 0.01 A. */
function current(v) {
  const a = (v & 0x7FFF) * 0.01;
  return (v & 0x8000) ? a : -a;
}

const round = (v, d = 3) => parseFloat(v.toFixed(d));

/** Decode a read-all payload into aiobmsble-style keys. */
function decode(payload) {
  const f = splitIds(payload);
  const out = {};
  const u16 = id => (f[id] && f[id].length >= 2 ? f[id].readUInt16BE(0) : undefined);
  const u32 = id => (f[id] && f[id].length >= 4 ? f[id].readUInt32BE(0) : undefined);

  if (f[0x79]) {
    const v = [];
    for (let i = 0; i + 2 < f[0x79].length; i += 3) {
      const cv = round(f[0x79].readUInt16BE(i + 1) * 0.001, 3);
      out[`cell_voltage_${f[0x79][i]}`] = cv;
      v.push(cv);
    }
    if (v.length) out.delta_voltage = round(Math.max(...v) - Math.min(...v), 3);
  }
  if (u16(0x80) !== undefined) out.temp_mosfet = temperature(u16(0x80));
  if (u16(0x81) !== undefined) out.temp_1 = temperature(u16(0x81));
  if (u16(0x82) !== undefined) out.temp_2 = temperature(u16(0x82));
  const temps = [out.temp_1, out.temp_2].filter(t => typeof t === 'number');
  if (temps.length) out.temperature = round(temps.reduce((a, t) => a + t, 0) / temps.length, 1);
  if (u16(0x83) !== undefined) out.voltage = round(u16(0x83) * 0.01, 2);
  if (u16(0x84) !== undefined) {
    out.current = round(current(u16(0x84)), 2);
    out.battery_charging = out.current > 0 ? 1 : 0;
    if (out.voltage !== undefined) out.power = round(out.voltage * out.current, 1);
  }
  if (f[0x85]) out.battery_level = f[0x85][0];
  if (u16(0x87) !== undefined) out.cycles = u16(0x87);
  if (u32(0x89) !== undefined) out.total_charge = u32(0x89);           // Ah cycled
  if (u16(0x8A) !== undefined) out.cell_count = u16(0x8A);
  if (u16(0x8B) !== undefined) { out.problem_code = u16(0x8B); out.problem = out.problem_code ? 1 : 0; }
  if (u16(0x8C) !== undefined) {
    const s = u16(0x8C);
    out.chrg_mosfet = s & 0x01 ? 1 : 0;
    out.dischrg_mosfet = s & 0x02 ? 1 : 0;
    out.balancer = s & 0x04 ? 1 : 0;
  }
  if (u32(0xAA) !== undefined) out.design_capacity = u32(0xAA);       // Ah
  if (u32(0xB9) !== undefined) out.actual_capacity = u32(0xB9);       // Ah, measured full capacity
  if (out.battery_level !== undefined && out.design_capacity) {
    out.cycle_charge = round(out.design_capacity * out.battery_level / 100, 1); // remaining Ah (from SOC)
  }
  return out;
}

module.exports = { buildRequest, frameLength, sync, parseFrame, splitIds, decode, temperature, current, sum16 };
