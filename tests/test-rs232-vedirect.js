/**
 * Test Victron VE.Direct frame parsing.
 * Run: /usr/bin/node tests/test-rs232-vedirect.js
 */
const assert = require('assert');

// Simulate decodeVedirectFrame from modules/rs232.js
function decodeVedirectFrame(frame, profile) {
  const results = {};
  for (const fieldDef of profile.fields || []) {
    const raw = frame[fieldDef.label];
    if (raw === undefined) continue;
    let val = parseFloat(raw);
    if (isNaN(val)) continue;
    if (fieldDef.scale) val *= fieldDef.scale;
    if (fieldDef.type === 'millivolt') val *= 0.001;
    if (fieldDef.type === 'milliamp') val *= 0.001;
    const metricName = fieldDef.metric_prefix
      ? `${fieldDef.metric_prefix}_${fieldDef.metric}`
      : fieldDef.metric;
    results[metricName] = parseFloat(val.toFixed(3));
  }
  return results;
}

const profile = {
  fields: [
    { label: 'V',   metric: 'battery_voltage', type: 'millivolt', unit: 'V' },
    { label: 'I',   metric: 'battery_current', type: 'milliamp',  unit: 'A' },
    { label: 'PPV', metric: 'solar_power',     scale: 1,     unit: 'W' },
    { label: 'SOC', metric: 'battery_soc',     scale: 0.1,   unit: '%' },
    { label: 'H1',  metric: 'daily_yield',     scale: 0.01,  unit: 'kWh' },
    { label: 'HSDS',metric: 'day_sequence',    scale: 1,     unit: '' },
  ],
};

// Simulate a full VE.Direct frame (what the parser accumulates between Checksum lines)
const frame = {
  V: '26200',    // 26200 mV → 26.200 V
  I: '1500',     // 1500 mA → 1.500 A
  PPV: '185',    // 185 W
  SOC: '872',    // 87.2 %
  H1: '221',     // 2.21 kWh
  HSDS: '42',    // day sequence 42
};

const result = decodeVedirectFrame(frame, profile);

assert.ok(Math.abs(result.battery_voltage - 26.200) < 0.001, 'battery_voltage');
assert.ok(Math.abs(result.battery_current - 1.500) < 0.001, 'battery_current');
assert.strictEqual(result.solar_power, 185, 'solar_power');
assert.strictEqual(result.battery_soc, 87.2, 'battery_soc');
assert.strictEqual(result.daily_yield, 2.21, 'daily_yield');
assert.strictEqual(result.day_sequence, 42, 'day_sequence');

console.log('✓ Victron VE.Direct: All 6 metrics parsed correctly');
console.log('  Result:', result);
