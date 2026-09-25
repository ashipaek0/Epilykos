#!/usr/bin/env node
/**
 * test/dongle-anern.test.js
 * Machiner validation fixture for the Anern EVO4200L (24V Hybrid, Modbus RTU).
 * No live hardware register reads are performed — this is a pure structural /
 * transform / decode-consistency check against profiles/rs232/anern-evo4200l.json.
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '..', 'profiles', 'rs232', 'anern-evo4200l.json');

if (!fs.existsSync(PROFILE_PATH)) {
  console.error(`FATAL: profile not found: ${PROFILE_PATH}`);
  process.exitCode = 2;
  process.exit(2);
}

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

/**
 * Anern registers are LITTLE-ENDIAN byte-swapped vs Epilykos' readUInt16BE.
 * The inverter sends value V as [lo, hi] bytes; readUInt16BE returns the
 * reversed word, and this swap restores it. Mirrors modules/dongle.js pollInstance.
 */
function swap(u16) {
  return ((u16 & 0xFF) << 8) | (u16 >> 8);
}

/** Decode a value the way pollInstance does: LE-sent bytes -> readUInt16BE -> swap -> scale. */
function decodeLE(lo, hi, scale) {
  const buf = Buffer.from([lo, hi]); // the two bytes the inverter actually sends (lo, hi)
  const raw = buf.readUInt16BE(0);   // Epilykos reads the word big-endian
  const restored = swap(raw);        // byte-swap transform
  return restored * scale;           // apply profile scale
}

// ---------------------------------------------------------------------------
// 1) Profile coherence
// ---------------------------------------------------------------------------
assert.strictEqual(profile.protocol, 'modbus-rtu', 'profile.protocol should be modbus-rtu');
assert.strictEqual(profile.transport, 'rs232', 'profile.transport should be rs232');
assert.strictEqual(profile.byte_order, 'le', 'profile.byte_order should be le');
assert.ok(Array.isArray(profile.metrics), 'profile.metrics should be an array');
assert.strictEqual(profile.metrics.length, 10, `expected 10 metrics, got ${profile.metrics.length}`);

const REG_LO = 0x1196;
const REG_HI = 0x11CD;
const registers = new Set();
for (const m of profile.metrics) {
  const reg = parseInt(m.register, 16);
  assert.strictEqual(typeof m.name, 'string');
  assert.strictEqual(typeof m.scale, 'number');
  assert.ok(
    reg >= REG_LO && reg <= REG_HI,
    `register ${m.register} (${reg}) outside 0x1196..0x11CD for ${m.name}`
  );
  registers.add(reg);
}
assert.strictEqual(registers.size, 10, 'all 10 registers must be distinct');

// ---------------------------------------------------------------------------
// 2) Little-endian byte-swap transform
// ---------------------------------------------------------------------------
// Inverter sends 230 as [0x00, 0xE6]; readUInt16BE -> 0xE600; swap() restores 230.
assert.strictEqual(swap(0xE600), 0x00E6, 'swap(0xE600) should be 0x00E6 (230)');
assert.strictEqual(swap(0xE600), 230, 'swap(0xE600) should equal 230');
// Inverter sends 280 as [0x18, 0x01]; readUInt16BE -> 0x1801; swap() restores 280.
assert.strictEqual(swap(0x1801), 0x0118, 'swap(0x1801) should be 0x0118 (280)');
assert.strictEqual(swap(0x1801), 280, 'swap(0x1801) should equal 280');
// Inverter sends 74 as [0x00, 0x4A]; readUInt16BE -> 0x4A00; swap() restores 74.
assert.strictEqual(swap(0x4A00), 0x004A, 'swap(0x4A00) should be 0x004A (74)');
assert.strictEqual(swap(0x4A00), 74, 'swap(0x4A00) should equal 74');

// ---------------------------------------------------------------------------
// 3) 24V-register decode sanity
// ---------------------------------------------------------------------------
function metricByName(name) {
  const m = profile.metrics.find((mm) => mm.name === name);
  assert.ok(m, `metric "${name}" not found in profile`);
  return m;
}

// battery_voltage: raw true value 280 (0x0118) sent as LE bytes [0x18, 0x01]
const bvMeta = metricByName('battery_voltage');
const bv = decodeLE(0x18, 0x01, bvMeta.scale);   // -> 28.0
assert.strictEqual(bv, 28.0, 'battery_voltage decode should be 28.0V');
assert.ok(bv >= 23.0 && bv <= 29.5, `battery_voltage ${bv}V outside 23.0-29.5V (24V bank)`);

// battery_soc: raw 50 (0x0032) sent as LE bytes [0x32, 0x00]
const socMeta = metricByName('battery_soc');
const soc = decodeLE(0x32, 0x00, socMeta.scale);  // -> 50
assert.strictEqual(soc, 50, 'battery_soc decode should be 50%');
assert.ok(soc >= 0 && soc <= 100, `battery_soc ${soc}% outside 0-100%`);

// ---------------------------------------------------------------------------
// 4) grid_frequency scale sanity (~50 Hz)
// ---------------------------------------------------------------------------
// raw 500 (0x01F4) sent as LE bytes [0xF4, 0x01]; readUInt16BE -> 0xF401; swap -> 500
const gfMeta = metricByName('grid_frequency');
const gf = decodeLE(0xF4, 0x01, gfMeta.scale);     // -> 50.0
assert.strictEqual(gf, 50.0, 'grid_frequency decode should be 50.0Hz');
assert.ok(gf >= 49.0 && gf <= 51.0, `grid_frequency ${gf}Hz not sane (~50Hz)`);

// ---------------------------------------------------------------------------
console.log('PASS: Anern EVO4200L profile coherence + LE byte-swap + 24V-range decode sanity');
console.log(`  protocol=${profile.protocol} transport=${profile.transport} byte_order=${profile.byte_order} metrics=${profile.metrics.length}`);
console.log(`  swap(0xE600)=${swap(0xE600)} swap(0x1801)=${swap(0x1801)} swap(0x4A00)=${swap(0x4A00)}`);
console.log(`  battery_voltage=${bv}V battery_soc=${soc}% grid_frequency=${gf}Hz`);
process.exitCode = 0;
