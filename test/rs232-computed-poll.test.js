'use strict';
const checks = require('./_checks');
/**
 * A whole RS232 poll of a Phocos Any-Grid over a fake serial port: the profile's computed fields (CALC) are worked out
 * from the replies of the poll, including readings that are not mapped, stored under the user's metric names; nothing is
 * sent for CALC; and a poll whose reply lacks an input stores the readings but no grid power.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-rs232-computed-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
process.env.LOG_TO_FILE = 'false';
const database = require('../modules/database');
database.initializeDatabase();
const phocos = require('../modules/rs232-decoders/phocos-ascii');

const LIVE = '230.0 50.0 231.5 50.1 0450 0380 009 380 51.20 004 075 0035 07.6 120.5 51.18 00008 00010110 00 00 01230 010 0 00 0000';
let live = LIVE;
const sent = [];
class FakePort extends EventEmitter {
  constructor(options) { super(); this.path = options.path; this.isOpen = false; }
  open(cb) { this.isOpen = true; cb(null); }
  close(cb) { this.isOpen = false; if (cb) cb(); }
  write(buf, cb) {
    const q = buf.toString('latin1').replace(/[^A-Z0-9]/g, '').slice(0, 5);
    sent.push(q);
    if (cb) cb(null);
    setImmediate(() => this.emit('data', phocos.frameReply(q === 'QPIGS' ? live : 'NAK')));
  }
}
const serial = require('serialport');
require.cache[require.resolve('serialport')].exports = { ...serial, SerialPort: FakePort };
const rs232 = require('../modules/rs232');
require.cache[require.resolve('serialport')].exports = serial;

(async () => {
  rs232.loadRs232Profiles();
  const profile = rs232.availableProfiles.find(p => p.id === 'phocos-anygrid-rs232');
  const cmd = profile.commands.find(c => c.name === 'QPIGS');
  const decoded = rs232.__decodeAsciiForTests
    ? rs232.__decodeAsciiForTests
    : (text) => {
        const out = {};
        const tokens = text.split(' ');
        for (const f of cmd.fields) { const v = parseFloat(tokens[f.source ?? f.index]); if (Number.isFinite(v) && f.bit === undefined && !f.lookup && f.type !== 'text') out[f.metric] = v * (f.scale || 1); }
        return out;
      };
  const r = decoded(LIVE);
  const expectedBattery = Math.round((r.battery_voltage * r.battery_charge_current - r.battery_voltage * r.battery_discharge_current) * 10) / 10;
  const expectedGrid = Math.round((r.output_power + expectedBattery - r.pv_power) * 10) / 10;
  assert.ok([r.output_power, r.battery_voltage, r.battery_charge_current, r.battery_discharge_current, r.pv_power, expectedGrid].every(Number.isFinite), JSON.stringify(r));

  // Only the grid power and the output are mapped: the battery and PV readings are used without being stored.
  database.setConfig('rs232_devices', JSON.stringify([{ name: 'anygrid', enabled: true, profile: 'phocos-anygrid-rs232', serial_path: '/dev/fake', baud: 2400,
    mappings: { 'Grid power': 'CALC:1', 'AC output': 'QPIGS:5' } }]));
  await rs232.pollRs232();
  database.flushMetrics();
  const latest = Object.fromEntries(database.getDb().prepare('SELECT metric, value FROM latest_metrics').all().map(x => [x.metric, x.value]));
  assert.strictEqual(latest['AC output'], r.output_power);
  assert.strictEqual(latest['Grid power'], expectedGrid, `grid power = output + battery net - PV (${JSON.stringify(latest)})`);
  assert.ok(!('battery_voltage' in latest) && !('pv_power' in latest) && !('battery_net_power' in latest), 'readings that are not mapped are not stored');
  assert.ok(!sent.some(q => q.startsWith('CALC')), 'nothing is sent for the computed fields');
  assert.ok(sent.includes('QPIGS'));

  // A reply missing the PV power: the readings are stored, the grid power is not made up.
  database.getDb().exec("DELETE FROM latest_metrics");
  live = LIVE.split(' ').slice(0, 16).join(' ');
  await rs232.pollRs232();
  database.flushMetrics();
  const again = Object.fromEntries(database.getDb().prepare('SELECT metric, value FROM latest_metrics').all().map(x => [x.metric, x.value]));
  assert.strictEqual(again['AC output'], r.output_power);
  assert.ok(!('Grid power' in again), 'no grid power when an input is missing: ' + JSON.stringify(again));

  rs232.shutdownRs232();
  console.log('ok - a poll works out the grid power from the replies, mapped under the user\'s name');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
