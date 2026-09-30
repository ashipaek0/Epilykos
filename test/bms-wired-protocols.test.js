'use strict';
/**
 * test/bms-jbd-jk.test.js — wired JBD and JK-BMS protocol decoders.
 *
 * Fixtures are real frames:
 *  - JBD 0x03 / 0x04 replies from the JBD protocol document (checksums valid).
 *  - JK read-all reply from syssi/esphome-jk-bms esp8266-example-faker.yaml
 *    (header/trailer from its comments; checksum 0x54D1 valid).
 *  - PACE protocol-25 request / analog reply from nkinnan/esphome-pace-bms
 *    (pace_bms_protocol_v25.cpp example frames; checksums valid).
 */
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'bms-jbd-jk-')));
const jbd = require(path.join(REPO, 'modules/bms-decoders/jbd'));
const jk = require(path.join(REPO, 'modules/bms-decoders/jk'));
const pace = require(path.join(REPO, 'modules/bms-decoders/pace'));
const { _readers } = require(path.join(REPO, 'modules/bmsWired'));

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const JBD_BASIC = hex('DD 03 00 1B 17 00 00 00 02 D0 03 E8 00 00 20 78 00 00 00 00 00 00 10 48 03 0F 02 0B 76 0B 82 FB FF 77');
const JBD_CELLS = hex('DD 04 00 1E 0F 66 0F 63 0F 63 0F 64 0F 3E 0F 63 0F 37 0F 5B 0F 65 0F 3B 0F 63 0F 63 0F 3C 0F 66 0F 3D F9 F9 77');
const PACE_REQUEST = '~25014642E00201FD30\r';
const PACE_ANALOG = Buffer.from('~25014600F07A0001100CC70CC80CC70CC70CC70CC50CC60CC70CC70CC60CC70CC60CC60CC70CC60CC7060B9B0B990B990B990BB30BBCFF1FCCCD12D303286A008C2710E1E4\r', 'ascii');
const JK_FRAME = hex('4e57011b00000000060001792a010eed020efa030ef7040eec050ef8060efa070ef1080ef8090ee30a0efa0b0ef10c0efb0d0efb0e0ef280001d81001e82001c8314ef8480d0850f860287000489000000008a000e8b00008c00078e16268f10ae900fd2910fa0920005930bea940c1c95000596012c9700079800039900059a00059b0ce49c00089d019e005a9f0046a00064a10064a20014a30046a40046a5ffeca6fff6a7ffeca8fff6a90eaa0000000eab01ac01ad0411ae01af01b0000ab114b231323334353600000000b300b4496e707574205573b532313031b60000e200b748362e585f5f53362e312e33535f5fb800b900000000ba425433303732303230313230303030323030353231303031c0010000000068000054d1');

/** Serial-port stand-in: answers each write with the next canned reply, in chunks. */
function fakePort(replies, { junk = Buffer.alloc(0), chunk = 7 } = {}) {
  const port = new EventEmitter();
  const writes = [];
  port.write = (buf, cb) => {
    writes.push(Buffer.from(buf));
    cb && cb();
    const reply = replies.shift();
    if (!reply) return;
    const data = Buffer.concat([junk, reply]);
    let i = 0;
    const next = () => {
      if (i >= data.length) return;
      port.emit('data', data.subarray(i, i + chunk));
      i += chunk;
      setImmediate(next);
    };
    setImmediate(next);
  };
  port.writes = writes;
  return port;
}

(async () => {
  // ── JBD ───────────────────────────────────────────────
  assert.strictEqual(jbd.buildRequest(0x03).toString('hex'), 'dda50300fffd77');
  assert.strictEqual(jbd.buildRequest(0x04).toString('hex'), 'dda50400fffc77');
  const basic = jbd.decodeBasic(jbd.parseFrame(JBD_BASIC, 0x03).data);
  assert.deepStrictEqual(
    [basic.voltage, basic.current, basic.battery_level, basic.cycle_charge, basic.design_capacity, basic.cell_count, basic.temp_1, basic.temp_2, basic.chrg_mosfet, basic.dischrg_mosfet],
    [58.88, 0, 72, 7.2, 10, 15, 20.3, 21.5, 1, 1]);
  const cells = jbd.decodeCells(jbd.parseFrame(JBD_CELLS, 0x04).data);
  assert.strictEqual(cells.cell_voltage_1, 3.942);
  assert.strictEqual(cells.cell_voltage_15, 3.901);
  assert.strictEqual(cells.delta_voltage, 0.047);
  const bad = Buffer.from(JBD_BASIC); bad[10] ^= 0xFF;
  assert.throws(() => jbd.parseFrame(bad, 0x03), /checksum/);
  const err = Buffer.from(JBD_BASIC); err[2] = 0x80;
  assert.throws(() => jbd.parseFrame(err, 0x03), /error status/);
  // negative current (discharge) is signed
  const dis = Buffer.from(JBD_BASIC.subarray(4, 4 + 27)); dis.writeInt16BE(-1250, 2);
  assert.strictEqual(jbd.decodeBasic(dis).current, -12.5);
  console.log('ok - JBD frames');

  // ── JK ────────────────────────────────────────────────
  assert.strictEqual(jk.buildRequest().toString('hex'), '4e5700130000000006030000000000006800000129');
  assert.strictEqual(jk.frameLength(JK_FRAME), JK_FRAME.length);
  const d = jk.decode(jk.parseFrame(JK_FRAME));
  assert.deepStrictEqual(
    [d.voltage, d.current, d.battery_level, d.cycles, d.cell_count, d.temp_mosfet, d.temp_1, d.temp_2, d.design_capacity],
    [53.59, 2.08, 15, 4, 14, 29, 30, 28, 14]);
  assert.strictEqual(d.cell_voltage_1, 3.821);
  assert.strictEqual(d.cell_voltage_14, 3.826);
  assert.strictEqual(d.power, 111.5);
  assert.deepStrictEqual([d.chrg_mosfet, d.dischrg_mosfet, d.balancer], [1, 1, 1]);
  assert.strictEqual(jk.current(0x04E2), -12.5);      // bit 15 clear = discharging
  assert.strictEqual(jk.temperature(101), -2);        // syssi: 99 - 101
  const jkBad = Buffer.from(JK_FRAME); jkBad[20] ^= 0x01;
  assert.throws(() => jk.parseFrame(jkBad), /checksum/);
  console.log('ok - JK frame');

  // ── PACE protocol 25 ──────────────────────────────────
  assert.strictEqual(pace.buildRequest(1).toString('ascii'), PACE_REQUEST);
  const pf = pace.parseFrame(PACE_ANALOG);
  assert.strictEqual(pf.address, 1);
  const pa = pace.decodeAnalog(pf.info);
  assert.deepStrictEqual(
    [pa.cell_count, pa.cell_voltage_1, pa.cell_voltage_16, pa.voltage, pa.current, pa.cycle_charge, pa.full_capacity, pa.design_capacity, pa.cycles, pa.battery_level],
    [16, 3.271, 3.271, 52.429, -2.25, 48.19, 103.46, 100, 140, 46.6]);
  assert.deepStrictEqual([pa.temp_1, pa.temp_4, pa.temp_mosfet, pa.temp_env], [24.1, 23.9, 26.5, 27.4]);
  const pBad = Buffer.from(PACE_ANALOG); pBad[20] = pBad[20] === 0x30 ? 0x31 : 0x30;
  assert.throws(() => pace.parseFrame(pBad), /checksum/);
  // A well-formed reply carrying return code 0x04 (invalid CID2) must surface that error.
  const errBody = '25014604' + '0000';
  const pErr = Buffer.from('~' + errBody + pace.frameChecksum(errBody).toString(16).toUpperCase().padStart(4, '0') + '\r', 'ascii');
  assert.throws(() => pace.parseFrame(pErr), /invalid CID2/);
  console.log('ok - PACE frames');

  // ── Serial framing: chunked replies with leading junk ─
  const jbdPort = fakePort([JBD_BASIC, JBD_CELLS], { junk: Buffer.from([0x00, 0x77, 0x12]) });
  const jbdData = await _readers.readJbd(jbdPort);
  assert.strictEqual(jbdData.voltage, 58.88);
  assert.strictEqual(jbdData.cell_voltage_15, 3.901);
  assert.deepStrictEqual(jbdPort.writes.map(w => w.toString('hex')), ['dda50300fffd77', 'dda50400fffc77']);
  const jkPort = fakePort([JK_FRAME], { junk: Buffer.from([0x4E, 0x00, 0xFF]), chunk: 32 });
  const jkData = await _readers.readJk(jkPort);
  assert.strictEqual(jkData.voltage, 53.59);
  assert.strictEqual(jkData.cell_count, 14);
  const pacePort = fakePort([PACE_ANALOG], { junk: Buffer.from('\r\n~x', 'ascii').subarray(0, 2), chunk: 16 });
  const paceData = await _readers.readPace(pacePort, { modbus_unit_id: 1 });
  assert.strictEqual(paceData.voltage, 52.429);
  assert.strictEqual(pacePort.writes[0].toString('ascii'), PACE_REQUEST);
  await assert.rejects(_readers.readPace(fakePort([PACE_ANALOG]), { modbus_unit_id: 2 }), /expected 2/);
  console.log('ok - serial framing');

  // ── Profiles ──────────────────────────────────────────
  for (const [file, protocol, baud] of [['jbd-bms', 'jbd', 9600], ['jk-bms', 'jk-rs485', 115200], ['pace-bms', 'pace-v25', 9600]]) {
    const p = JSON.parse(fs.readFileSync(path.join(REPO, 'profiles/rs232', file + '.json'), 'utf8'));
    assert.strictEqual(p.protocol, protocol);
    assert.strictEqual(p.defaults.baud, baud);
    assert.ok(/bms/i.test(file + ' ' + p.name), 'wired BMS pickers list profiles with "bms" in id/name');
    for (const key of ['voltage', 'current', 'battery_level', 'cell_voltage_1']) {
      assert.ok(p.metrics.some(m => m.field === key), file + ' lists ' + key);
    }
  }
  console.log('ok - profiles');
  console.log('# bms-jbd-jk-pace: all passed');
})().catch(e => { console.error('not ok -', e); process.exit(1); });
