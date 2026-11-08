'use strict';
// A LuxPower poll cycle reads only the register blocks the instance's mapped
// metrics sit in (plus what decoding needs), not every block the profile lists:
// fewer reads per cycle means fewer chances for the dongle to drop the
// connection, and a control change waits behind fewer queued reads.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'lux-plan-')));
process.env.ENC_KEY_FILE = path.join(process.cwd(), 'key');
require('../modules/database').initializeDatabase();
const dongle = require('../modules/dongle');
const profile = require('../profiles/dongles/luxpower-geta-3k6-24v.json');

const keyOf = m => `${m.register_type}:${m.register}`;
const byName = n => profile.metrics.find(m => m.name === n);
const mappingsFor = names => Object.fromEntries(names.map(n => [n, keyOf(byName(n))]));
const instance = names => ({ name: 'GETA', prefix: '', mappings: mappingsFor(names) });

// Every word the dongle could hold, with values that differ per register.
function wordsEverywhere() {
  const words = {};
  for (const space of ['input', 'holding']) for (let a = 0; a < 200; a++) words[`${space}:${a}`] = space === 'holding' && a === 19 ? 26 : (a * 37 + (space === 'input' ? 5 : 11)) % 3000;
  words['input:80'] = 2;   // flags: a lithium battery report
  return words;
}
function readRecorder() {
  const reads = [];
  return { reads, async readRegisters(start, count, fn) {
    reads.push([fn === 4 ? 'input' : 'holding', start, count]);
    const all = wordsEverywhere(), b = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) b.writeUInt16LE(all[`${fn === 4 ? 'input' : 'holding'}:${start + i}`] || 0, i * 2);
    return b;
  } };
}
const pollWith = async names => {
  const t = readRecorder(), inst = instance(names);
  await dongle.pollLuxpowerInstance(inst, t, profile);
  return t.reads;
};

test('two mapped input metrics need one block, not ten', async () => {
  const reads = await pollWith(['battery_soc', 'pv1_power']);
  assert.deepEqual(reads, [['input', 0, 40]]);
});

test('a mapped holding metric reads its block; nothing else is read', async () => {
  const holding = profile.metrics.find(m => m.register_type === 'holding' && parseInt(m.register, 16) >= 80 && parseInt(m.register, 16) < 120);
  assert.ok(holding, 'the profile has a holding metric in 80..119');
  const reads = await pollWith([holding.name]);
  assert.deepEqual(reads, [['holding', 80, 40]]);
});

test('a battery-current metric also reads the flags (input 80) and the model (holding 19)', async () => {
  const reads = await pollWith(['bms_max_charge_current']);
  const has = (space, start) => reads.some(r => r[0] === space && r[1] === start);
  assert.ok(has('input', 80), 'flags word');
  assert.ok(has('holding', 0), 'model word');
  assert.equal(reads.length, 2);
});

test('nothing mapped on an explicit profile: one small read to see that the dongle answers', async () => {
  const reads = await pollWith([]);
  assert.equal(reads.length, 1);
});

test('a profile that emits everything still reads every listed block', async () => {
  const open = { ...profile, mapping: undefined };
  const t = readRecorder();
  await dongle.pollLuxpowerInstance({ name: 'GETA', prefix: '' }, t, open);
  assert.equal(t.reads.length, profile.read_ranges.input.length + profile.read_ranges.holding.length);
});

test('decoding from only the blocks that were read gives the same values as from every block', () => {
  const all = wordsEverywhere();
  // Deterministic pseudo-random subsets of the profile's metrics, plus the awkward ones.
  let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const wide = profile.metrics.filter(m => m.count === 2 || m.decode).map(m => m.name);
  const sets = [wide, profile.metrics.map(m => m.name)];
  for (let i = 0; i < 40; i++) sets.push(profile.metrics.filter(() => rand() < 0.15).map(m => m.name));
  for (const names of sets) {
    const plan = dongle.luxpowerPollPlan(profile, instance(names));
    const wanted = Object.fromEntries(Object.keys(all).map(k => [k, all[k]]));
    const partial = {};
    for (const space of ['input', 'holding']) {
      const blocks = plan.all ? profile.read_ranges[space].map(([start, count]) => ({ start, count }))
        : profile.read_ranges[space].map(([start, count]) => ({ start, count })).filter(b => { for (let a = b.start; a < b.start + b.count; a++) if (plan.words[space].has(a)) return true; return false; });
      for (const b of blocks) for (let a = b.start; a < b.start + b.count; a++) partial[`${space}:${a}`] = wanted[`${space}:${a}`];
    }
    const full = dongle.decodeLuxpowerMetrics(profile, instance(names), all);
    const part = dongle.decodeLuxpowerMetrics(profile, instance(names), partial);
    assert.deepEqual(part, full, `same values for ${names.length} mapped metrics`);
  }
});

test('a two-word value that straddles two blocks reads both', async () => {
  const synthetic = {
    protocol: 'luxpower-tcp', mapping: 'explicit',
    read_ranges: { input: [[0, 40], [40, 40], [80, 40]], holding: [] },
    metrics: [{ name: 'energy_total', register: '0x0027', register_type: 'input', type: 'uint32', count: 2, word_order: 'lsb_first' }]
  };
  const t = readRecorder();
  await dongle.pollLuxpowerInstance({ name: 'X', prefix: '', mappings: { energy_total: 'input:0x0027' } }, t, synthetic);
  assert.deepEqual(t.reads, [['input', 0, 40], ['input', 40, 40]]);
});
