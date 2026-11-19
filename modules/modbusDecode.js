'use strict';
/**
 * Reading a Modbus profile's registers and turning the words into numbers. Pure apart from the client passed in,
 * so it is tested against a fake one.
 *
 * A register entry has { metric, address, type, scale, unit, label } and optionally:
 *   function    'holding' (function 03, the default) or 'input' (function 04)
 *   word_order  for 32- and 64-bit values: 'msw_first' (the high word at the lower address, the default) or 'lsw_first'
 * A profile can set `function` and `wordOrder` once for all its registers; an entry's own setting wins.
 *
 * A 32-bit value covers two registers and a 64-bit one four, starting at its address; a profile lists only the first.
 * Reads are grouped into blocks of up to 32 words, one function code at a time, and every block is read once even when
 * several entries sit inside it.
 */

const WIDTH = { uint16: 1, int16: 1, uint32: 2, int32: 2, uint64: 4 };
const SIGNED = new Set(['int16', 'int32']);
const MAX_BLOCK = 32;

const widthOf = reg => WIDTH[reg.type] || 1;

/** 3 (holding) or 4 (input) for a register entry. */
function functionOf(reg, defaults = {}) {
  const f = reg.function || defaults.function;
  return f === 'input' || f === 4 ? 4 : 3;
}

function wordOrderOf(reg, defaults = {}) {
  return (reg.word_order || defaults.wordOrder) === 'lsw_first' ? 'lsw_first' : 'msw_first';
}

/** Blocks to read: [{ fn, start, count, regs }], sorted, never longer than 32 words, never splitting an entry. */
function planBlocks(registers, defaults = {}, maxWords = MAX_BLOCK) {
  const sorted = [...registers].sort((a, b) => functionOf(a, defaults) - functionOf(b, defaults) || a.address - b.address);
  const blocks = [];
  let cur = null;
  for (const reg of sorted) {
    const fn = functionOf(reg, defaults);
    const end = reg.address + widthOf(reg) - 1;
    if (cur && cur.fn === fn && reg.address <= cur.end + 1 && Math.max(cur.end, end) - cur.start + 1 <= maxWords) {
      cur.regs.push(reg); cur.end = Math.max(cur.end, end);
    } else {
      cur = { fn, start: reg.address, end, regs: [reg] };
      blocks.push(cur);
    }
  }
  return blocks.map(b => ({ fn: b.fn, start: b.start, count: b.end - b.start + 1, regs: b.regs }));
}

/** The number a register entry holds, from the block's words. null when the words don't cover it. */
function decodeValue(reg, words, offset, defaults = {}) {
  const w = widthOf(reg);
  if (offset < 0 || offset + w > words.length) return null;
  let raw;
  if (w === 1) {
    raw = words[offset];
    if (SIGNED.has(reg.type) && raw > 0x7FFF) raw -= 0x10000;
  } else {
    let slice = words.slice(offset, offset + w);
    if (wordOrderOf(reg, defaults) === 'lsw_first') slice = slice.reverse();
    let big = 0n;
    for (const word of slice) big = (big << 16n) | BigInt(word & 0xFFFF);
    if (SIGNED.has(reg.type) && big >= (1n << BigInt(w * 16 - 1))) big -= (1n << BigInt(w * 16));
    raw = Number(big);
  }
  // Scaling by a tenth gives 512.3000000000001 for 5123; six decimals is far finer than any register is.
  return reg.scale ? Math.round(raw * reg.scale * 1e6) / 1e6 : raw;
}

/**
 * Read every register of a profile.
 * @param {object} client   modbus-serial-like: readHoldingRegisters(addr, n), readInputRegisters(addr, n) → { data }
 * @param {object[]} registers
 * @param {object} [opts]   { function, wordOrder } profile defaults; nameOf(reg) → the metric name to store (falsy to skip)
 * @returns {Promise<{ values: object, blocks: number, failed: {start: number, error: Error}[] }>}
 */
async function readRegisters(client, registers, opts = {}) {
  const nameOf = opts.nameOf || (reg => reg.metric);
  const values = {};
  const failed = [];
  const blocks = planBlocks(registers, opts);
  for (const block of blocks) {
    let words;
    try {
      const resp = block.fn === 4 ? await client.readInputRegisters(block.start, block.count) : await client.readHoldingRegisters(block.start, block.count);
      words = resp.data;
    } catch (error) { failed.push({ start: block.start, fn: block.fn, error }); continue; }
    for (const reg of block.regs) {
      const value = decodeValue(reg, words, reg.address - block.start, opts);
      const name = nameOf(reg);
      if (name && value !== null) values[name] = value;
    }
  }
  return { values, blocks: blocks.length, failed };
}

module.exports = { WIDTH, MAX_BLOCK, widthOf, functionOf, wordOrderOf, planBlocks, decodeValue, readRegisters };
