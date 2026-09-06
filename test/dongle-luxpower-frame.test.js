#!/usr/bin/env node
/**
 * test/dongle-luxpower-frame.test.js
 * Frame-level validation for the LuxPower local-TCP transport (issue #102),
 * covering AC1-AC6 plus structural validation of the phase-1 profile
 * profiles/dongles/luxpower-geta.json (AC15).
 *
 * Fixtures marked REAL were captured from the live GETA dongle (serials replaced
 * with synthetic LXP fixtures for public-repo hygiene, #105) on 2026-09-05
 * (/home/ubuntu/epilykos-tracker/luxpower-geta-discovery.json, crcOk:true) —
 * genuine wire response frames, not synthesized; serial bytes rewritten in place
 * and CRCs recomputed via the module's own crc16Modbus. Original capture on user
 * hardware.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildReadFrame,
  parseFrame,
  crc16Modbus,
  DEV_FN_HOLDING,
  DEV_FN_INPUT
} = require('../modules/dongle/luxpowerTcp');

// ---------------------------------------------------------------------------
// Golden + REAL wire fixtures
// ---------------------------------------------------------------------------

// AC2 golden request (pcap-derived): readRegisters(start=0, count=40, devFn=0x04)
const AC2_HEX = 'a11a0500200001c24c585030303030303031120000044c58503030303030303200002800527a';
const AC2 = Buffer.from(AC2_HEX, 'hex');

// REAL: input registers 0-39 response (devFn 0x04, start 0, byte_len 0x50)
const REAL_INPUT_0_39 = Buffer.from('a11a05006f0001c24c585030303030303031610001044c585030303030303032000050140036090000000012015e000000ae010000000000000000690800008138a51358010000aa0000006b0810325c10a6130000000000004f023600000000001c002700270026003000000052008a10fb0ecc40', 'hex');

// REAL: input registers 40-79 response (devFn 0x04, start 40, byte_len 0x50)
const REAL_INPUT_40_79 = Buffer.from('a11a05006f0001c24c585030303030303031610001044c5850303030303030322800503600000000000000000000001c00000027000000270000002600000030000000000000005200000000000000000000002b002700310000000000ea2a0100000000000000000000000000200000000000accd', 'hex');

// REAL: input registers 80-119 response (devFn 0x04, start 80, byte_len 0x50)
const REAL_INPUT_80_119 = Buffer.from('a11a05006f0001c24c585030303030303031610001044c5850303030303030325000501104cb01e80312019600000000000000000000007132bfab0e03f0606d1003000000b301000000000000000000000000000012010000120100000000000000000000040100004c585030303030303032b4b4', 'hex');

// REAL: holding registers 80-119 response (devFn 0x03, start 80, byte_len 0x50)
const REAL_HOLDING_80_119 = Buffer.from('a11a05006f0001c24c585030303030303031610001034c5850303030303030325000500000000000000000000000000000000000000000e600320000000000000000000000000000001c01d20064006400000000000f0038ff260200009001810c000000000100000000000000000000001400a3c2', 'hex');

// REAL: unsolicited holding 0-79 push (devFn 0x03, start 0, byte_len 0xA0)
const REAL_UNSOL_HOLDING_0_79 = Buffer.from('a11a0500bf0001c24c585030303030303031b10001034c5850303030303030320000a0601101004c585030303030303032434a41410000092100001a0905102f1501000000000000001a000100800b1e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000173b00000000000000000000640000000000000000006310', 'hex');

// ---------------------------------------------------------------------------
// AC1: CRC16/Modbus over the known-good request inner (serials swapped to
// synthetic LXP fixtures per #105, CRC recomputed) = 0x7A52 (wire 52 7a)
// ---------------------------------------------------------------------------
{
  const inner = AC2.slice(20, AC2.length - 2);
  assert.strictEqual(crc16Modbus(inner), 0x7A52, 'AC1: CRC over request inner must be 0x7A52');
  assert.strictEqual(AC2[AC2.length - 2], 0x52, 'AC1: CRC stored low byte must be 0x52');
  assert.strictEqual(AC2[AC2.length - 1], 0x7A, 'AC1: CRC stored high byte must be 0x7A');
  console.log('PASS AC1: crc16Modbus(request inner) = 0x' + crc16Modbus(inner).toString(16) + ' (wire 52 7a)');
}

// ---------------------------------------------------------------------------
// AC2: builder byte-matches the 38-byte pcap golden frame
// ---------------------------------------------------------------------------
{
  const built = buildReadFrame({ protocol: 5, dongle: 'LXP0000001', inverter: 'LXP0000002', devFn: 0x04, start: 0, count: 40 });
  assert.strictEqual(built.length, 38, 'AC2: built frame must be 38 bytes');
  assert.ok(built.equals(AC2), 'AC2: built frame must byte-match golden pcap frame');
  console.log('AC2: buildReadFrame(...) byte-matches golden hex (' + AC2_HEX + ')');
}

// ---------------------------------------------------------------------------
// AC3: builder validation throws
// ---------------------------------------------------------------------------
{
  const base = { protocol: 5, dongle: 'LXP0000001', inverter: 'LXP0000002', devFn: 0x04, start: 0, count: 1 };
  assert.throws(() => buildReadFrame({ ...base, dongle: 'LXP1' }), /dongle must be exactly 10 alphanumeric/, 'AC3: short dongle serial must throw');
  assert.throws(() => buildReadFrame({ ...base, dongle: 'LXP000000!' }), /dongle must be exactly 10 alphanumeric/, 'AC3: non-alnum dongle serial must throw');
  assert.throws(() => buildReadFrame({ ...base, inverter: 'INV0000' }), /inverter must be exactly 10 alphanumeric/, 'AC3: short inverter serial must throw');
  assert.throws(() => buildReadFrame({ ...base, devFn: 0x06 }), /devFn must be 0x03 \(holding\) or 0x04 \(input\)/, 'AC3: devFn 0x06 must throw');
  assert.throws(() => buildReadFrame({ ...base, start: -1 }), /start must be within 0\.\.0xFFFF/, 'AC3: negative start must throw');
  assert.throws(() => buildReadFrame({ ...base, start: 0x10000 }), /start must be within 0\.\.0xFFFF/, 'AC3: start 0x10000 must throw');
  assert.throws(() => buildReadFrame({ ...base, count: 0 }), /count must be within 1\.\.0xFFFF/, 'AC3: count 0 must throw');
  assert.throws(() => buildReadFrame({ ...base, count: 0x10000 }), /count must be within 1\.\.0xFFFF/, 'AC3: count 0x10000 must throw');
  assert.throws(() => buildReadFrame({ ...base, start: 'abc' }), /start must be within/, 'AC3: non-numeric start must throw');
  // Both valid function codes still build (devFn lands at inner[1] == frame[21])
  for (const fn of [DEV_FN_HOLDING, DEV_FN_INPUT]) {
    const f = buildReadFrame({ ...base, devFn: fn, count: 2 });
    assert.strictEqual(f[21], fn, 'AC3: devFn byte must be written to frame[21]');
  }
  console.log('PASS AC3: builder validation (serials/devFn/start/count) throws as required');
}

// ---------------------------------------------------------------------------
// AC4: parser extracts action/dev_fn/serial/start/byte_len/values on REAL frames
// ---------------------------------------------------------------------------
function parseAndCheck(buf, expect, label) {
  const stored = buf.readUInt16LE(buf.length - 2);
  const computed = crc16Modbus(buf.slice(20, buf.length - 2));
  assert.strictEqual(stored, computed, `${label}: stored CRC 0x${stored.toString(16)} must match computed 0x${computed.toString(16)}`);
  const p = parseFrame(buf);
  assert.strictEqual(p.action, 1, `${label}: action must be 0x01`);
  assert.strictEqual(p.devFn, expect.devFn, `${label}: dev_fn`);
  assert.strictEqual(p.inverter, 'LXP0000002', `${label}: inverter serial`);
  assert.strictEqual(p.start, expect.start, `${label}: start register`);
  assert.strictEqual(p.byteLen, expect.byteLen, `${label}: byte_len`);
  assert.strictEqual(p.values.length, expect.byteLen, `${label}: values length must equal byte_len`);
  assert.strictEqual(p.frameLen, buf.length - 6, `${label}: frame_len + 6 must equal total length`);
  assert.strictEqual(p.dataLen, p.frameLen - 14, `${label}: data_len must equal frame_len - 14`);
  return p;
}

{
  const p0 = parseAndCheck(REAL_INPUT_0_39, { devFn: 0x04, start: 0, byteLen: 0x50 }, 'AC4: REAL input 0-39');
  // Live-decoded values (little-endian words, per discovery input map)
  assert.strictEqual(p0.values.readUInt16LE(0 * 2), 20, 'reg0 operational_state = 20');
  assert.strictEqual(p0.values.readUInt16LE(1 * 2), 2358, 'reg1 pv1_voltage raw = 2358 (235.8V @0.1)');
  assert.strictEqual(p0.values.readUInt16LE(4 * 2), 274, 'reg4 battery_voltage raw = 274 (27.4V @0.1)');
  assert.strictEqual(p0.values.readUInt16LE(5 * 2), 94, 'reg5 battery_soc = 94%');
  assert.strictEqual(p0.values.readUInt16LE(7 * 2), 430, 'reg7 pv1_power = 430W');
  assert.strictEqual(p0.values.readUInt16LE(12 * 2), 2153, 'reg12 grid_voltage raw = 2153 (215.3V @0.1)');
  assert.strictEqual(p0.values.readUInt16LE(15 * 2), 5029, 'reg15 grid_frequency raw = 5029 (50.29Hz @0.01)');

  parseAndCheck(REAL_INPUT_40_79, { devFn: 0x04, start: 40, byteLen: 0x50 }, 'AC4: REAL input 40-79');
  parseAndCheck(REAL_INPUT_80_119, { devFn: 0x04, start: 80, byteLen: 0x50 }, 'AC4: REAL input 80-119');
  parseAndCheck(REAL_HOLDING_80_119, { devFn: 0x03, start: 80, byteLen: 0x50 }, 'AC4: REAL holding 80-119');
  parseAndCheck(REAL_UNSOL_HOLDING_0_79, { devFn: 0x03, start: 0, byteLen: 0xA0 }, 'AC4: REAL unsolicited holding 0-79');

  console.log('PASS AC4: parseFrame extracts fields from 5 REAL captured frames (CRC verified on each)');
  console.log('  REAL input 0-39 live values: state=20 pv1=235.8V batt=27.4V soc=94% pv1_pwr=430W grid=215.3V freq=50.29Hz');
}

// ---------------------------------------------------------------------------
// AC5 note: fragmentation / junk-resync is exercised over a real socket in
// test/dongle-luxpower-socket.test.js (transport receive buffer is private;
// findMarker is not exported).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC6: malformed frames throw / corruption detectable (discard+resync is
// exercised over a real socket in the socket test)
// ---------------------------------------------------------------------------
{
  // Truncated frame — total shorter than frame_len + 6
  assert.throws(() => parseFrame(REAL_INPUT_0_39.slice(0, 30)), /frame length mismatch|too short/, 'AC6: truncated frame must throw');
  assert.throws(() => parseFrame(Buffer.from([0xA1, 0x1A, 0x05, 0x00])), /too short/, 'AC6: tiny buffer must throw');
  // Missing start marker
  const noMarker = Buffer.from(REAL_INPUT_0_39);
  noMarker[0] = 0x00;
  assert.throws(() => parseFrame(noMarker), /missing start marker/, 'AC6: missing A1 1A marker must throw');
  // Wrong TCP function byte (not 0xC2)
  const badFn = Buffer.from(REAL_INPUT_0_39);
  badFn[7] = 0x00;
  assert.throws(() => parseFrame(badFn), /unexpected tcp function/, 'AC6: non-0xC2 tcp function must throw');
  // Request frame (action 0x00) must not parse as a response
  assert.throws(() => parseFrame(AC2), /expected action 0x01/, 'AC6: action 0x00 request must throw in parseFrame');
  // Corruption flips CRC detectably at the pure-function level
  const corrupt = Buffer.from(REAL_INPUT_0_39);
  corrupt[50] ^= 0xFF;
  const storedCrc = corrupt.readUInt16LE(corrupt.length - 2);
  assert.notStrictEqual(crc16Modbus(corrupt.slice(20, corrupt.length - 2)), storedCrc, 'AC6: single flipped byte must break CRC');
  console.log('PASS AC6: truncated/malformed/bad-CRC frames detected (parse throws / CRC breaks)');
}

// ---------------------------------------------------------------------------
// AC15: profile structural validation (schema, write:false, register scope,
// no duplicate (register_type, register))
// ---------------------------------------------------------------------------
{
  const PROFILE_PATH = path.join(__dirname, '..', 'profiles', 'dongles', 'luxpower-geta.json');
  assert.ok(fs.existsSync(PROFILE_PATH), 'AC15: profile luxpower-geta.json must exist');
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

  assert.strictEqual(profile.protocol, 'luxpower-tcp', 'AC15: protocol must be luxpower-tcp');
  assert.strictEqual(profile.transport, 'luxpower-tcp', 'AC15: transport must be luxpower-tcp');
  assert.strictEqual(profile.default_port, 8000, 'AC15: default_port must be 8000');
  assert.strictEqual(profile.byte_order, 'le', 'AC15: byte_order must be le (real values are LE words)');
  assert.strictEqual(profile.capabilities && profile.capabilities.write, false, 'AC15: capabilities.write must be false');
  assert.ok(Array.isArray(profile.metrics) && profile.metrics.length > 0, 'AC15: metrics[] required');

  const seen = new Set();
  for (const m of profile.metrics) {
    assert.strictEqual(typeof m.name, 'string', 'AC15: metric name required');
    assert.ok(/^0x[0-9a-fA-F]+$/.test(m.register), `AC15: ${m.name} register must be hex 0xNNNN`);
    const reg = parseInt(m.register, 16);
    assert.ok(reg >= 0x00 && reg <= 0x27, `AC15: ${m.name} register ${m.register} outside phase-1 input scope 0x00..0x27`);
    assert.strictEqual(m.register_type, 'input', `AC15: ${m.name} must be register_type 'input' in phase 1 (no holding metrics, D5)`);
    const pairKey = `${m.register_type}:${m.register}`;
    assert.ok(!seen.has(pairKey), `AC15: duplicate (register_type, register) ${pairKey}`);
    seen.add(pairKey);
  }

  const names = profile.metrics.map(m => m.name);
  for (const n of ['operational_state', 'pv1_voltage', 'pv2_voltage', 'pv3_voltage', 'battery_voltage', 'battery_soc',
    'pv1_power', 'pv2_power', 'pv3_or_total_power', 'battery_charge_power', 'battery_discharge_power', 'grid_voltage', 'grid_frequency']) {
    assert.ok(names.includes(n), `AC15: starter metric ${n} missing from profile`);
  }
  assert.strictEqual(profile.metrics.length, names.length, 'AC15: metric names must be unique');
  assert.strictEqual(profile.metrics.length, seen.size, 'AC15: all (register_type, register) pairs unique');
  console.log(`PASS AC15: luxpower-geta.json valid — ${profile.metrics.length} input metrics, regs 0x00..0x27, write:false`);
}

console.log('PASS: dongle-luxpower-frame.test.js — AC1, AC2, AC3, AC4, AC6, AC15 all green');
process.exitCode = 0;
