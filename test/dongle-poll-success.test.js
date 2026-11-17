'use strict';
const checks = require('./_checks');
// A Wi-Fi or Bluetooth Modbus dongle poll that works is counted as working
// (modules/dongle.js pollInstance). Its last line once named an undefined
// variable, so every good poll threw after storing its readings: it was logged
// as failed and counted in consecutiveFails, and Bluetooth units were backed
// off as if they did not answer.
const assert = require('node:assert/strict');
const path = require('path');
const { logger } = require('../modules/logger');
const database = require('../modules/database');

const warnings = [];
logger.warn = (m) => warnings.push(String(m));
const written = [];
database.queueMetricValue = (metric, value) => written.push([metric, value]);
const dongle = require('../modules/dongle');

(async () => {
  const profile = {
    poll_ranges: [{ start: 0x10, count: 2 }, { start: 0x20, count: 1 }],
    metrics: [
      { register: '0x0010', name: 'pv_power', type: 'uint16', unit: 'W' },
      { register: '0x0011', name: 'battery_soc', type: 'uint16', unit: '%' },
      { register: '0x0020', name: 'grid_power', type: 'int16', unit: 'W' },
    ],
  };
  const regs = { 0x10: 1500, 0x11: 87, 0x20: 0xFFF6 };   // -10 W
  const transport = {
    async readRegisters(start, count) {
      const buf = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) buf.writeUInt16BE(regs[start + i] || 0, i * 2);
      return buf;
    },
  };
  const inst = { name: 'Garage', consecutiveFails: 3 };
  await dongle.pollInstance(inst, transport, profile);
  assert.equal(inst.consecutiveFails, 0, 'a poll that worked clears the failure count');
  assert.ok(inst.lastSeen, 'and marks the unit as seen');
  assert.deepEqual(warnings.filter(w => /poll failed/.test(w)), [], 'and is not logged as failed');
  console.log('ok - a dongle poll that works is not counted as a failure');

  // A real failure is still counted.
  const broken = { async readRegisters() { throw new Error('connect ECONNREFUSED'); } };
  const down = { name: 'Roof', consecutiveFails: 0 };
  await dongle.pollInstance(down, broken, profile);
  assert.equal(down.consecutiveFails, 1);
  assert.ok(warnings.some(w => /Roof: poll failed — connect ECONNREFUSED/.test(w)));
  console.log('ok - a poll that fails is still counted');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
