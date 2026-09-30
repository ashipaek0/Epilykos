/**
 * JBD / Jiabaida "Smart BMS" wired protocol (UART-TTL or RS485), also sold as
 * Overkill Solar, Xiaoxiang and many rebrands. 9600 8N1.
 *
 * Request:  DD A5 <cmd> 00 <chk_hi> <chk_lo> 77
 * Response: DD <cmd> <status> <len> <data…> <chk_hi> <chk_lo> 77
 * Checksum: 0x10000 − sum(bytes from <cmd>/<status> through the last data byte).
 *   cmd 0x03 — basic info (voltage, current, capacity, SOC, FETs, temps)
 *   cmd 0x04 — cell voltages (2 bytes each, mV)
 *
 * Field layout per syssi/esphome-jbd-bms (components/jbd_bms/jbd_bms.cpp).
 * Output keys match aiobmsble's names so a pack reads the same over Bluetooth
 * and over the wire.
 *
 * @module bms-decoders/jbd
 */
'use strict';

const START = 0xDD;
const END = 0x77;
const CMD_BASIC = 0x03;
const CMD_CELLS = 0x04;

function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return (0x10000 - sum) & 0xFFFF;
}

/** Read request for a register (0x03 basic info, 0x04 cells). */
function buildRequest(cmd) {
  const chk = checksum([cmd, 0x00]);
  return Buffer.from([START, 0xA5, cmd, 0x00, chk >> 8, chk & 0xFF, END]);
}

/**
 * Bytes needed for the frame at the start of buf (after syncing on 0xDD),
 * or null while the header is incomplete.
 */
function frameLength(buf) {
  if (buf.length < 4) return null;
  return 4 + buf[3] + 3;
}

/** Drop bytes before the first 0xDD. */
function sync(buf) {
  const i = buf.indexOf(START);
  return i < 0 ? Buffer.alloc(0) : buf.subarray(i);
}

/** Validate a complete response frame → { cmd, data }. Throws on error. */
function parseFrame(frame, expectCmd) {
  if (frame.length < 7 || frame[0] !== START) throw new Error('JBD: bad frame start');
  const len = frame[3];
  if (frame.length < 7 + len) throw new Error('JBD: frame too short');
  if (frame[6 + len] !== END) throw new Error('JBD: bad frame end');
  if (expectCmd !== undefined && frame[1] !== expectCmd) throw new Error(`JBD: unexpected reply 0x${frame[1].toString(16)}`);
  if (frame[2] !== 0x00) throw new Error(`JBD: BMS reported error status 0x${frame[2].toString(16)}`);
  const want = checksum(frame.subarray(2, 4 + len));
  const got = frame.readUInt16BE(4 + len);
  if (want !== got) throw new Error('JBD: checksum mismatch');
  return { cmd: frame[1], data: frame.subarray(4, 4 + len) };
}

const round = (v, d = 3) => parseFloat(v.toFixed(d));

/** Decode cmd 0x03 data. */
function decodeBasic(d) {
  if (d.length < 23) throw new Error('JBD: basic info too short');
  const voltage = d.readUInt16BE(0) * 0.01;
  const current = d.readInt16BE(2) * 0.01; // + charge, − discharge
  const out = {
    voltage: round(voltage, 2),
    current: round(current, 2),
    power: round(voltage * current, 1),
    cycle_charge: round(d.readUInt16BE(4) * 0.01, 2),   // remaining Ah
    design_capacity: round(d.readUInt16BE(6) * 0.01, 2), // nominal Ah
    cycles: d.readUInt16BE(8),
    balancer: d.readUInt32BE(12),
    problem_code: d.readUInt16BE(16),
    battery_level: d[19],
    chrg_mosfet: d[20] & 0x01 ? 1 : 0,
    dischrg_mosfet: d[20] & 0x02 ? 1 : 0,
    cell_count: d[21],
  };
  out.problem = out.problem_code ? 1 : 0;
  out.battery_charging = current > 0 ? 1 : 0;
  const ntc = Math.min(d[22], 6);
  const temps = [];
  for (let i = 0; i < ntc && 23 + i * 2 + 1 < d.length; i++) {
    const t = round((d.readUInt16BE(23 + i * 2) - 2731) * 0.1, 1);
    out[`temp_${i + 1}`] = t;
    temps.push(t);
  }
  if (temps.length) out.temperature = round(temps.reduce((a, t) => a + t, 0) / temps.length, 1);
  return out;
}

/** Decode cmd 0x04 data. */
function decodeCells(d) {
  const out = {};
  const cells = Math.min(Math.floor(d.length / 2), 32);
  const v = [];
  for (let i = 0; i < cells; i++) {
    const cv = round(d.readUInt16BE(i * 2) * 0.001, 3);
    out[`cell_voltage_${i + 1}`] = cv;
    v.push(cv);
  }
  if (v.length) out.delta_voltage = round(Math.max(...v) - Math.min(...v), 3);
  return out;
}

module.exports = { CMD_BASIC, CMD_CELLS, buildRequest, frameLength, sync, parseFrame, decodeBasic, decodeCells, checksum };
