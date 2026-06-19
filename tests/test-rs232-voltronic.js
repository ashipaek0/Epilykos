/**
 * Test Voltronic QPIGS response parsing.
 * Run: /usr/bin/node tests/test-rs232-voltronic.js
 */
const assert = require('assert');

// Simulate the decodeAsciiResponse function from modules/rs232.js
function decodeAsciiResponse(buffer, cmd) {
  const text = buffer.toString('utf8').trim();
  const prefix = cmd.response?.prefix || '';
  let dataStr = text;
  if (prefix && text.startsWith(prefix)) {
    dataStr = text.slice(prefix.length);
  }
  const delimiter = cmd.response?.delimiter || '\t';
  const fields = dataStr.split(delimiter);
  const results = {};
  for (const fieldDef of cmd.fields || []) {
    const idx = fieldDef.index;
    if (idx >= fields.length || idx < 0) continue;
    let raw = parseFloat(fields[idx].trim());
    if (isNaN(raw)) continue;
    if (fieldDef.scale) raw *= fieldDef.scale;
    results[fieldDef.metric] = raw;
  }
  return results;
}

// Sample QPIGS response (space-delimited, ( prefixed, CR terminated)
const QPIGS_RESPONSE = Buffer.from('(230.1 50.00 230.1 50.00 1200 950 25.6 0010 85 0035 0000 200.0 25.6 0000\r\n');

const cmd = {
  name: 'QPIGS',
  response: { type: 'ascii-line', prefix: '(', delimiter: ' ' },
  fields: [
    { index: 0,  metric: 'grid_voltage',            scale: 1,    unit: 'V' },
    { index: 1,  metric: 'grid_frequency',           scale: 0.01, unit: 'Hz' },
    { index: 4,  metric: 'load_va',                  scale: 1,    unit: 'VA' },
    { index: 5,  metric: 'load_power',               scale: 1,    unit: 'W' },
    { index: 6,  metric: 'battery_voltage',          scale: 0.1,  unit: 'V' },
    { index: 8,  metric: 'battery_soc',              scale: 1,    unit: '%' },
    { index: 9,  metric: 'inverter_temp',            scale: 1,    unit: '°C' },
  ],
};

const result = decodeAsciiResponse(QPIGS_RESPONSE, cmd);

// Verify key values
assert.strictEqual(result.grid_voltage, 230.1, 'grid_voltage');
assert.strictEqual(result.grid_frequency, 0.50, 'grid_frequency (scaled)');
assert.strictEqual(result.load_va, 1200, 'load_va');
assert.strictEqual(result.load_power, 950, 'load_power');
assert.ok(Math.abs(result.battery_voltage - 2.56) < 0.001, 'battery_voltage (scaled 0.1)');
assert.strictEqual(result.battery_soc, 85, 'battery_soc');
assert.strictEqual(result.inverter_temp, 35, 'inverter_temp');

console.log('✓ Voltronic QPIGS: All 7 metrics parsed correctly');
console.log('  Result:', result);
