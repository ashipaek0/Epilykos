'use strict';
const checks = require('./_checks');
// Phocos polls: identity, ratings and settings blocks are read every 20th poll
// (and after a settings read), and their snapshot metrics are written when
// they change or every few minutes, not on every poll.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-phocos-cadence-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();

const profile = require('../profiles/dongles/phocos-anygrid-ble.json');
const { BleGattTransport, identityCheck } = require('../modules/dongle/bleGatt');
const { pollJsonInstance } = require('../modules/dongle');

function payload(block) {
  const buf = Buffer.alloc(Math.max(block.minimumLength || 0, block.length || 0, 20));
  if (block.id === 'ratings') { buf.writeUInt16LE(2300, 4); buf.writeUInt16LE(5000, 12); buf.writeUInt16LE(480, 14); }
  if (block.id === 'identity_serial') { buf.write('SERIAL', 0); buf[19] = 0x39; }
  if (block.id === 'settings_2a0c') buf.writeUInt16LE(543, 6);
  if (block.id === 'status') buf[12] = 66;
  return buf;
}

(async () => {
  const reads = [];
  const fakeRead = async (_address, wanted) => {
    reads.push(wanted.length);
    return wanted.map(w => payload(profile.blocks.find(b => b.characteristic === w.characteristic) || profile.settingBlocks.find(b => b.characteristic === w.characteristic)));
  };
  const slow = profile.blocks.filter(b => b.every > 1).length;
  assert.ok(slow >= 6, 'identity, ratings and settings blocks are marked');
  const t = new BleGattTransport({ ble_address: 'AA:BB:CC:DD:EE:FF' }, profile, { read: fakeRead });
  const first = await t.poll();
  assert.equal(reads[0], profile.blocks.length, 'the first poll reads everything');
  for (let i = 1; i < 20; i++) await t.poll();
  assert.ok(reads.slice(1, 20).every(n => n === profile.blocks.length - slow), `polls 2–20 read only live blocks: ${reads.slice(1, 20)}`);
  const cached = await t.poll();
  assert.equal(reads[20], profile.blocks.length, 'every 20th poll reads them again');
  assert.equal(cached.settings.float_voltage, first.settings.float_voltage, 'cached blocks still decode');
  assert.equal(cached.identity.modelId, '9');
  await t.poll(); assert.equal(reads.at(-1), profile.blocks.length - slow);
  await t.settings();
  await t.poll(); assert.equal(reads.at(-1), profile.blocks.length, 'a settings read refreshes them on the next poll');
  console.log('ok - slow blocks are read every 20th poll and after a settings read');

  // What the Bluetooth Test shows for checking the model byte by eye.
  const check = identityCheck(first);
  assert.equal(check.serial, 'SERIAL');
  assert.equal(check.modelCode, '9');
  assert.deepEqual(check.byte19, { index: 19, hex: '39', char: '9' });
  assert.deepEqual(check.byte18, { index: 18, hex: '00', char: null });
  assert.equal(check.rawHex.length, 40);
  assert.equal(check.nominalVoltage, 48); assert.equal(check.watts, 5000);
  assert.equal(check.writable, true);
  assert.equal(identityCheck({ raw: {} }), null, 'nothing to show without the identity block');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /identityCheck: identityCheck\(data\)/, 'the test route returns it');
  console.log('ok - the Bluetooth Test reports serial, model code and bytes 18/19');

  // Snapshot fields: written once, then not again until they change or 4 min pass.
  const instance = { name: 'P1', prefix: 'p1_', mappings: { p1_rated: 'ratings.outputPower', p1_soc: 'status[0]' } };
  const transport = { poll: async () => ({ ratings: { outputPower: 5000 }, status: [80] }) };
  const written = () => database.getDb().prepare("SELECT metric FROM metrics WHERE metric IN ('p1_rated','p1_soc')").all().map(r => r.metric);
  const countOf = m => written().filter(x => x === m).length;
  const realNow = Date.now; let clock = realNow();
  Date.now = () => clock;
  const poll = async () => { clock += 15000; await pollJsonInstance(instance, transport, profile); database.flushMetrics(); };
  try {
    await poll(); await poll();
    assert.equal(countOf('p1_soc'), 2, 'live values every poll');
    assert.equal(countOf('p1_rated'), 1, 'the rating once');
    for (let i = 0; i < 15; i++) await poll();   // 4 min 15 s
    assert.equal(countOf('p1_soc'), 17);
    assert.equal(countOf('p1_rated'), 2, 'and again after 4 minutes');
    transport.poll = async () => ({ ratings: { outputPower: 6500 }, status: [80] });
    await poll();
    assert.equal(countOf('p1_rated'), 3, 'and when it changes');
  } finally { Date.now = realNow; }
  console.log('ok - snapshot fields are written on change');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
