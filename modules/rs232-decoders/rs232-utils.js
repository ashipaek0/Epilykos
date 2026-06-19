/**
 * rs232-utils.js
 * Helper utilities for RS232 inverter communication.
 * CRC, byte utils, XOR checksum, port helpers.
 */

// ── CRC16-Modbus (standard CRC-16/MODBUS) ────────────────────────────────
// For SolaX AA55 additive checksum, see solax-decoder.js

const CRC16_TABLE = buildCrc16Table();

function buildCrc16Table() {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xA001 ^ (crc >> 1)) : (crc >> 1);
    }
    table[i] = crc;
  }
  return table;
}

function crc16Modbus(data) {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc = CRC16_TABLE[(crc ^ byte) & 0xFF] ^ (crc >> 8);
  }
  return crc;
}

// ── XOR Checksum (Victron VE.Direct style) ──────────────────────────────
// XOR all bytes; result should be 0 for a valid frame

function xorChecksumValid(data) {
  let checksum = 0;
  for (const byte of data) {
    checksum ^= byte;
  }
  return checksum === 0;
}

// ── Additive 16-bit LE Checksum (SolaX AA55 style) ──────────────────────
// Sum all bytes as uint16, little-endian

function additiveChecksum16LE(data) {
  let sum = 0;
  for (const byte of data) {
    sum = (sum + byte) & 0xFFFF;
  }
  return sum;
}

// ── Byte Helpers ─────────────────────────────────────────────────────────

function toHexString(buffer) {
  return Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function fromHexString(str) {
  const hex = str.replace(/\s/g, '');
  return Buffer.from(hex, 'hex');
}

// ── Port Matching Helpers ────────────────────────────────────────────────

// USB VID:PID lookup for common inverter adapters
const KNOWN_ADAPTERS = {
  '067b:2303': { name: 'Prolific PL2303', brands: ['Generic', 'Voltronic', 'Growatt'] },
  '0403:6001': { name: 'FTDI FT232', brands: ['Victron VE.Direct', 'Fronius'] },
  '10c4:ea60': { name: 'Silicon Labs CP210x', brands: ['SMA', 'Goodwe'] },
  '1a86:7523': { name: 'CH340 / CH341', brands: ['Generic', 'Voltronic clones'] },
  '0403:6015': { name: 'FTDI FT231X', brands: ['Victron VE.Direct (official cable)'] },
};

function identifyAdapter(port) {
  const vidpid = `${port.vendorId}:${port.productId}`;
  return KNOWN_ADAPTERS[vidpid] || null;
}

module.exports = {
  crc16Modbus,
  xorChecksumValid,
  additiveChecksum16LE,
  toHexString,
  fromHexString,
  identifyAdapter,
  KNOWN_ADAPTERS,
};
