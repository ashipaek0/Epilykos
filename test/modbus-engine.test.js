'use strict';
const checks = require('./_checks');
// The Modbus engine: how registers are grouped into reads, input registers (function 04), 32- and 64-bit values in
// either word order, signs, and that every shipped profile plans cleanly.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { planBlocks, decodeValue, readRegisters, widthOf, functionOf } = require('../modules/modbusDecode');

const reg = (o) => Object.assign({ metric: 'm', address: 0, type: 'uint16', scale: 1, unit: '', label: '' }, o);

// ── Widths and function codes ────────────────────────────────────────────
assert.deepEqual(['uint16', 'int16', 'uint32', 'int32', 'uint64'].map(t => widthOf({ type: t })), [1, 1, 2, 2, 4]);
assert.equal(functionOf({}), 3); assert.equal(functionOf({ function: 'input' }), 4); assert.equal(functionOf({}, { function: 'input' }), 4);
assert.equal(functionOf({ function: 'holding' }, { function: 'input' }), 3, 'an entry beats the profile default');

// ── Planning reads ───────────────────────────────────────────────────────
const plan = (regs, d, max) => planBlocks(regs, d, max).map(b => [b.fn, b.start, b.count, b.regs.length]);
assert.deepEqual(plan([reg({ address: 10 }), reg({ address: 11 }), reg({ address: 12 })]), [[3, 10, 3, 3]], 'neighbours share one read');
assert.deepEqual(plan([reg({ address: 10 }), reg({ address: 12 })]), [[3, 10, 1, 1], [3, 12, 1, 1]], 'a gap starts a new read');
assert.deepEqual(plan([reg({ address: 5, type: 'uint32' })]), [[3, 5, 2, 1]], 'a 32-bit value reads both words even when the second is not listed');
assert.deepEqual(plan([reg({ address: 5, type: 'uint64' })]), [[3, 5, 4, 1]], 'and a 64-bit one four');
assert.deepEqual(plan([reg({ address: 5, type: 'uint32' }), reg({ address: 7 })]), [[3, 5, 3, 2]], 'a neighbour right after the pair joins the read');
assert.deepEqual(plan([reg({ address: 5, type: 'uint32' }), reg({ address: 6, metric: 'x' })]), [[3, 5, 2, 2]], 'a listed second word is read once');
assert.deepEqual(plan([reg({ address: 9 }), reg({ address: 5 })]), [[3, 5, 1, 1], [3, 9, 1, 1]], 'sorted by address');
assert.deepEqual(plan([reg({ address: 5 }), reg({ address: 5, function: 'input' })]), [[3, 5, 1, 1], [4, 5, 1, 1]], 'function 03 and 04 are never mixed');
assert.deepEqual(plan([reg({ address: 5 }), reg({ address: 6 })], { function: 'input' }), [[4, 5, 2, 2]], 'profile default');
const many = Array.from({ length: 40 }, (_, i) => reg({ address: 100 + i, metric: 'r' + i }));
assert.deepEqual(plan(many), [[3, 100, 32, 32], [3, 132, 8, 8]], 'reads are at most 32 words');
const edge = [...Array.from({ length: 31 }, (_, i) => reg({ address: 100 + i, metric: 'r' + i })), reg({ address: 131, type: 'uint32', metric: 'wide' })];
assert.deepEqual(plan(edge), [[3, 100, 31, 31], [3, 131, 2, 1]], 'a 32-bit value is never cut in two by the limit');
assert.deepEqual(plan([]), []);

// ── Decoding ─────────────────────────────────────────────────────────────
const dec = (r, words, o = 0, d) => decodeValue(reg(r), words, o, d);
assert.equal(dec({ type: 'uint16', scale: 0.1 }, [5123]), 512.3);
assert.equal(dec({ type: 'int16' }, [0xFFFF]), -1);
assert.equal(dec({ type: 'int16', scale: 0.1 }, [0xFF9C]), -10);
assert.equal(dec({ type: 'uint16' }, [0xFFFF]), 65535);
assert.equal(dec({ type: 'uint32' }, [0x0001, 0x0002]), 65538, 'high word first by default');
assert.equal(dec({ type: 'uint32', word_order: 'lsw_first' }, [0x0002, 0x0001]), 65538, 'low word first');
assert.equal(dec({ type: 'uint32' }, [0x0002, 0x0001], 0, { wordOrder: 'lsw_first' }), 65538, 'profile default word order');
assert.equal(dec({ type: 'uint32', word_order: 'msw_first' }, [0x0001, 0x0002], 0, { wordOrder: 'lsw_first' }), 65538, 'an entry beats the profile');
assert.equal(dec({ type: 'int32' }, [0xFFFF, 0xFFFE]), -2, 'a negative 32-bit value');
assert.equal(dec({ type: 'int32', scale: 0.1 }, [0xFFFF, 0xFF9C]), -10, 'scaled and signed');
assert.equal(dec({ type: 'uint32' }, [0xFFFF, 0xFFFF]), 4294967295);
assert.equal(dec({ type: 'uint64' }, [0, 0, 1, 2]), 65538);
assert.equal(dec({ type: 'uint64', word_order: 'lsw_first' }, [2, 1, 0, 0]), 65538);
assert.equal(dec({ type: 'uint64' }, [0, 1, 0, 0]), 4294967296, 'above 32 bits');
assert.equal(dec({ type: 'uint16' }, [1, 2, 3], 2), 3, 'offset into a block');
assert.equal(dec({ type: 'uint32' }, [1], 0), null, 'words that do not cover the value');
assert.equal(dec({ type: 'uint16' }, [1], 1), null);
assert.equal(dec({ type: 'uint16', scale: 0 }, [7]), 7, 'no scale means as read');

// ── Reading with a fake device ───────────────────────────────────────────
function fake(holding, input, failAt) {
  const calls = [];
  return {
    calls,
    async readHoldingRegisters(a, n) { calls.push(['h', a, n]); if (failAt === a) throw new Error('timeout'); return { data: Array.from({ length: n }, (_, i) => holding[a + i] ?? 0) }; },
    async readInputRegisters(a, n) { calls.push(['i', a, n]); if (failAt === -a) throw new Error('timeout'); return { data: Array.from({ length: n }, (_, i) => input[a + i] ?? 0) }; },
  };
}
(async () => {
  // The bug this fixes: a lone uint32 used to be read as one word and so showed only its high half.
  let c = fake({ 33057: 0x0001, 33058: 0x86A0 });   // 100000
  let r = await readRegisters(c, [reg({ metric: 'total_dc_power', address: 33057, type: 'uint32' })]);
  assert.deepEqual(c.calls, [['h', 33057, 2]]); assert.equal(r.values.total_dc_power, 100000);
  // A negative 32-bit value.
  c = fake({ 40: 0xFFFF, 41: 0xFC18 });
  r = await readRegisters(c, [reg({ metric: 'battery_power', address: 40, type: 'int32' })]);
  assert.equal(r.values.battery_power, -1000);
  // Input registers, low word first, scaled.
  c = fake({ 9: 111 }, { 9: 0x0BB8, 10: 0x0000, 3000: 2300 });
  r = await readRegisters(c, [reg({ metric: 'a', address: 9, type: 'uint32', scale: 0.1, function: 'input', word_order: 'lsw_first' }), reg({ metric: 'b', address: 3000, scale: 0.1, function: 'input' }), reg({ metric: 'h', address: 9 })]);
  assert.deepEqual(c.calls.map(x => x[0] + x[1] + 'x' + x[2]).sort(), ['h9x1', 'i3000x1', 'i9x2']);
  assert.equal(r.values.a, 300); assert.equal(r.values.b, 230); assert.equal(r.values.h, 111, 'the same number as a holding register is a different value');
  // Profile defaults apply to every entry.
  c = fake({}, { 1: 5, 2: 6 });
  r = await readRegisters(c, [reg({ metric: 'x', address: 1 }), reg({ metric: 'y', address: 2 })], { function: 'input' });
  assert.deepEqual(c.calls, [['i', 1, 2]]); assert.deepEqual(r.values, { x: 5, y: 6 });
  // Names come from the caller (user mappings and prefixes); an entry with no name is skipped.
  c = fake({ 1: 5, 2: 6 });
  r = await readRegisters(c, [reg({ metric: 'x', address: 1 }), reg({ metric: 'y', address: 2 })], { nameOf: g => (g.address === 1 ? 'dev_' + g.metric : null) });
  assert.deepEqual(r.values, { dev_x: 5 });
  // One block failing does not stop the others, and says which.
  c = fake({ 1: 5, 100: 9 }, {}, 1);
  r = await readRegisters(c, [reg({ metric: 'x', address: 1 }), reg({ metric: 'z', address: 100 })]);
  assert.deepEqual(r.values, { z: 9 }); assert.equal(r.blocks, 2); assert.equal(r.failed.length, 1); assert.equal(r.failed[0].start, 1); assert.match(r.failed[0].error.message, /timeout/);
  // A short answer leaves the entry out rather than inventing a value.
  const short = { async readHoldingRegisters() { return { data: [1] }; }, async readInputRegisters() { return { data: [] }; } };
  r = await readRegisters(short, [reg({ metric: 'w', address: 5, type: 'uint32' })]);
  assert.deepEqual(r.values, {}, 'half a value is no value');

  // ── Every shipped profile ──────────────────────────────────────────────
  const dir = path.join(__dirname, '..', 'profiles');
  let total = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const blocks = planBlocks(p.registers, { function: p.function, wordOrder: p.wordOrder });
    for (const b of blocks) assert.ok(b.count >= 1 && b.count <= 32, `${f}: block at ${b.start} has ${b.count} words`);
    const covered = new Set(); blocks.forEach(b => b.regs.forEach(x => covered.add(x)));
    assert.equal(covered.size, p.registers.length, `${f}: every register is in a block`);
    const words = {};
    const res = await readRegisters({ async readHoldingRegisters(a, n) { return { data: Array.from({ length: n }, (_, i) => (a + i) & 0xFFFF) }; }, async readInputRegisters(a, n) { return { data: Array.from({ length: n }, () => 1) }; } }, p.registers, { function: p.function, wordOrder: p.wordOrder });
    assert.equal(res.failed.length, 0, `${f}: reads cleanly`);
    assert.equal(Object.keys(res.values).length, p.registers.length, `${f}: every metric gets a value`);
    total += p.registers.length;
  }
  assert.ok(total > 500, 'looked at the shipped registers');

  // The poller carries the defaults of a profile through.
  const modbus = require('../modules/modbus');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'modules/modbus.js'), 'utf8'), /readRegisters\(client, registersToPoll/);
  modbus.loadProfiles();
  const sample = modbus.availableProfiles[0];
  assert.ok(['holding', 'input'].includes(sample.function) && ['msw_first', 'lsw_first'].includes(sample.wordOrder), 'loaded profiles carry function and word order');

  console.log('ok - modbus engine');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
