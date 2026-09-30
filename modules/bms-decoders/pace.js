/**
 * PACE BMS "paceic" ASCII protocol, version 0x25 — PACE's published
 * RS232 / RS485 protocol used by many rebranded packs (Jakiper, Easun,
 * Tewaycell, Greenrich, FSP, Eenovance/Sunsynk…). 9600 8N1 (some 19200).
 *
 * Frame (every field hex-encoded ASCII):
 *   ~ VER ADR CID1 CID2|RTN LENGTH INFO CHKSUM \r
 *   VER 25, CID1 46 (lithium), CID2 42 = read analog information,
 *   LENGTH = 4-bit length checksum + 12-bit INFO length (in ASCII chars),
 *   CHKSUM = two's complement of the sum of the ASCII bytes VER…INFO.
 * Request INFO is the pack address (DIP switch), e.g. "~25014642E00201FD30\r".
 *
 * Analog information (CID2 0x42) payload, bytes:
 *   00, address, cell count, cells (u16 mV)…, temperature count,
 *   temperatures (u16, 0.1 K offset 2730)…, current (i16, 10 mA),
 *   pack voltage (u16 mV), remaining (u16, 10 mAh), user-defined (u8),
 *   full capacity (u16, 10 mAh), cycles (u16), design capacity (u16, 10 mAh),
 *   then vendor-specific trailing bytes (ignored).
 * Counts are read from the frame, so 6- and 8-temperature variants and the
 * variants with extra trailing bytes decode alike.
 *
 * Source: nkinnan/esphome-pace-bms (pace_bms_protocol_base.cpp, _v25.cpp).
 * Output keys match aiobmsble.
 *
 * @module bms-decoders/pace
 */
'use strict';

const SOI = 0x7E; // '~'
const EOI = 0x0D; // '\r'
const VERSION = 0x25;
const CID1_LITHIUM = 0x46;
const CID2_ANALOG = 0x42;

const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');

/** 4-bit length checksum in the top nibble, 12-bit length below. */
function checksummedLength(len) {
  const sum = (len & 0xF) + ((len >> 4) & 0xF) + ((len >> 8) & 0xF);
  return (((~sum + 1) & 0xF) << 12) | (len & 0x0FFF);
}

/** Frame checksum over the ASCII bytes between '~' and the checksum. */
function frameChecksum(ascii) {
  let sum = 0;
  for (let i = 0; i < ascii.length; i++) sum += ascii.charCodeAt(i);
  return (~sum + 1) & 0xFFFF;
}

/** Read-analog-information request for a pack address (1-16 DIP setting). */
function buildRequest(address = 1, version = VERSION) {
  const info = hex2(address & 0xFF);
  const body = hex2(version) + hex2(address & 0xFF) + hex2(CID1_LITHIUM) + hex2(CID2_ANALOG) + hex4(checksummedLength(info.length)) + info;
  return Buffer.from('~' + body + hex4(frameChecksum(body)) + '\r', 'ascii');
}

/** Bytes needed for the frame at the start of buf: up to the first '\r'. */
function frameLength(buf) {
  const end = buf.indexOf(EOI);
  return end < 0 ? null : end + 1;
}

/** Drop bytes before the first '~'. */
function sync(buf) {
  const i = buf.indexOf(SOI);
  return i < 0 ? Buffer.alloc(0) : buf.subarray(i);
}

const RETURN_CODES = {
  0x01: 'version error', 0x02: 'checksum error', 0x03: 'length checksum error',
  0x04: 'invalid CID2', 0x05: 'command format error', 0x06: 'invalid data',
  0x90: 'address error', 0x91: 'communication error',
};

/** Validate a response → { version, address, info: Buffer }. Throws on error. */
function parseFrame(frame) {
  const text = frame.toString('ascii');
  if (text[0] !== '~' || text[text.length - 1] !== '\r' || text.length < 18) throw new Error('PACE: bad frame');
  const body = text.slice(1, -5);
  if (!/^[0-9A-Fa-f]+$/.test(body + text.slice(-5, -1))) throw new Error('PACE: frame is not hex');
  if (frameChecksum(body) !== parseInt(text.slice(-5, -1), 16)) throw new Error('PACE: checksum mismatch');
  const rtn = parseInt(body.slice(6, 8), 16);
  if (rtn !== 0) throw new Error(`PACE: BMS returned error 0x${hex2(rtn)} (${RETURN_CODES[rtn] || 'unknown'})`);
  const lenField = parseInt(body.slice(8, 12), 16);
  const len = lenField & 0x0FFF;
  if (checksummedLength(len) !== lenField) throw new Error('PACE: length checksum mismatch');
  if (body.length !== 12 + len) throw new Error('PACE: length mismatch');
  return {
    version: parseInt(body.slice(0, 2), 16),
    address: parseInt(body.slice(2, 4), 16),
    info: Buffer.from(body.slice(12), 'hex'),
  };
}

const round = (v, d = 3) => parseFloat(v.toFixed(d));

/** Decode an analog-information payload (one pack). */
function decodeAnalog(info) {
  let o = 0;
  const u8 = () => { if (o + 1 > info.length) throw new Error('PACE: payload too short'); return info[o++]; };
  const u16 = () => { if (o + 2 > info.length) throw new Error('PACE: payload too short'); const v = info.readUInt16BE(o); o += 2; return v; };
  const i16 = () => { const v = u16(); return v > 0x7FFF ? v - 0x10000 : v; };

  u8();                // data flag (0x00)
  u8();                // pack address
  const out = {};
  const cells = u8();
  if (!cells || cells > 32) throw new Error(`PACE: implausible cell count ${cells}`);
  const v = [];
  for (let i = 1; i <= cells; i++) {
    const cv = round(u16() * 0.001, 3);
    out[`cell_voltage_${i}`] = cv;
    v.push(cv);
  }
  out.cell_count = cells;
  out.delta_voltage = round(Math.max(...v) - Math.min(...v), 3);
  const temps = u8();
  const t = [];
  for (let i = 1; i <= temps; i++) {
    const c = round((u16() - 2730) * 0.1, 1);
    out[`temp_${i}`] = c;
    t.push(c);
  }
  // Standard 6-sensor layout: 4 cell sensors, then MOSFET, then environment.
  if (temps === 6) { out.temp_mosfet = t[4]; out.temp_env = t[5]; }
  const cellTemps = t.slice(0, Math.min(4, t.length));
  if (cellTemps.length) out.temperature = round(cellTemps.reduce((a, x) => a + x, 0) / cellTemps.length, 1);
  out.current = round(i16() * 0.01, 2);          // + charge, − discharge
  out.voltage = round(u16() * 0.001, 3);
  out.power = round(out.voltage * out.current, 1);
  out.battery_charging = out.current > 0 ? 1 : 0;
  out.cycle_charge = round(u16() * 0.01, 2);     // remaining Ah
  out.protocol_variant = u8();                   // "user defined" value (3 = standard)
  const full = round(u16() * 0.01, 2);
  out.full_capacity = full;
  out.cycles = u16();
  out.design_capacity = round(u16() * 0.01, 2);
  if (full > 0) out.battery_level = round(Math.min(100, out.cycle_charge / full * 100), 1);
  if (out.design_capacity > 0) out.battery_health = round(Math.min(100, full / out.design_capacity * 100), 1);
  return out;
}

module.exports = { buildRequest, frameLength, sync, parseFrame, decodeAnalog, checksummedLength, frameChecksum };
