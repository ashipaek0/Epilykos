'use strict';

/**
 * Tests for the PVOutput metric mapper (issue #76 — .toFixed crash on
 * non-numeric metric values).
 *
 * Run: /usr/bin/node --test tests/mapper.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { buildStatusPayload } = require('../modules/pvoutput/mapper');

// 12:34 UTC rounds down to the 12:30 PVOutput slot.
const DATE = new Date('2026-08-11T12:34:00Z');

function baseConfig(overrides = {}) {
  return {
    timezone: 'UTC',
    metric_map: { v5: 'temp_c', v6: 'voltage_v' },
    donation_mode: false,
    battery_enabled: false,
    net_mode: false,
    ...overrides
  };
}

test('numeric strings coerce and round: v5 "42.5" -> 42.5, v6 "24.56" -> 24.6', () => {
  const payload = buildStatusPayload(
    { temp_c: '42.5', voltage_v: '24.56' },
    baseConfig(),
    DATE
  );
  assert.strictEqual(payload.v5, 42.5);
  assert.strictEqual(payload.v6, 24.6);
  assert.strictEqual(typeof payload.v5, 'number');
  assert.strictEqual(typeof payload.v6, 'number');
});

test('non-numeric strings "N/A"/"abc" -> key omitted', () => {
  const payload = buildStatusPayload(
    { temp_c: 'N/A', voltage_v: 'abc' },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for "N/A"');
  assert.ok(!('v6' in payload), 'v6 should be omitted for "abc"');
});

test('null/undefined -> key omitted', () => {
  const payload = buildStatusPayload(
    { temp_c: null, voltage_v: undefined },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for null');
  assert.ok(!('v6' in payload), 'v6 should be omitted for undefined');
});

test('NaN/Infinity/-Infinity -> key omitted', () => {
  const payload = buildStatusPayload(
    { temp_c: NaN, voltage_v: Infinity },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for NaN');
  assert.ok(!('v6' in payload), 'v6 should be omitted for Infinity');

  const payload2 = buildStatusPayload({ temp_c: -Infinity }, baseConfig(), DATE);
  assert.ok(!('v5' in payload2), 'v5 should be omitted for -Infinity');
});

test('empty/whitespace-only strings -> key omitted (no 0.0 falsification)', () => {
  const payload = buildStatusPayload(
    { temp_c: '', voltage_v: '   ' },
    baseConfig(),
    DATE
  );
  assert.ok(!('v5' in payload), 'v5 should be omitted for empty string');
  assert.ok(!('v6' in payload), 'v6 should be omitted for whitespace-only string');
});

test('mixed donation loop: v7="bad" omitted, v8="25.556" -> 25.56 present', () => {
  const config = baseConfig({
    donation_mode: true,
    metric_map: { v7: 'don_a', v8: 'don_b' }
  });
  const payload = buildStatusPayload({ don_a: 'bad', don_b: '25.556' }, config, DATE);
  assert.ok(!('v7' in payload), 'v7 should be omitted for "bad"');
  assert.strictEqual(payload.v8, 25.56);
});

test('all-numeric control payload matches pre-fix shape', () => {
  const config = {
    timezone: 'UTC',
    metric_map: {
      v1: 'energy_kwh', v2: 'power_w', v3: 'consume_kwh', v4: 'consume_w',
      v5: 'temp_c', v6: 'voltage_v',
      v7: 'don1', v8: 'don2', v9: 'don3', v10: 'don4', v11: 'don5', v12: 'don6',
      b1: 'batt_w', soc_metric: 'soc'
    },
    donation_mode: true,
    battery_enabled: true,
    net_mode: false,
    c1_mode: 1
  };
  const metrics = {
    energy_kwh: 12.345,  // v1 = 12 (Math.round)
    power_w: 1234.5,     // v2 = 1235 (Math.round)
    consume_kwh: 5.5,    // v3 = 6 (Math.round)
    consume_w: 300.2,    // v4 = 300 (Math.round)
    temp_c: '42.5',      // v5 = 42.5 (toFixed(1))
    voltage_v: '24.56',  // v6 = 24.6 (toFixed(1))
    don1: '1.111',       // v7 = 1.11
    don2: '2.222',       // v8 = 2.22
    don3: '3.333',       // v9 = 3.33
    don4: '4.444',       // v10 = 4.44
    don5: '5.556',       // v11 = 5.56
    don6: '6.666',       // v12 = 6.67
    batt_w: 150.4,       // b1 = 150 (Math.round)
    soc: 96              // b2 = 3 (soc >= 95 => Full)
  };
  const payload = buildStatusPayload(metrics, config, DATE);
  assert.deepStrictEqual(payload, {
    d: '20260811',
    t: '12:30',
    v1: 12,
    c1: 1,
    v2: 1235,
    v3: 6,
    v4: 300,
    v5: 42.5,
    v6: 24.6,
    b1: 150,
    b2: 3,
    v7: 1.11,
    v8: 2.22,
    v9: 3.33,
    v10: 4.44,
    v11: 5.56,
    v12: 6.67
  });
});
