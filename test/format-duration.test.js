#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { formatDuration } = require('../public/js/components/format.js');

const cases = [
  [0, '00:00'],
  [9 / 60, '00:09'],
  [45 / 60, '00:45'],
  [3, '3:00'],
  [3 + 12 / 60, '3:12'],
  [24 + 5 / 60, '24:05'],
  [0.49 / 60, '00:00'],
  [0.51 / 60, '00:01'],
  [1 + 59.5 / 60, '2:00'],
];

for (const [hours, expected] of cases) {
  assert.strictEqual(formatDuration(hours), expected, `${hours} hours should format as ${expected}`);
}
console.log(`format-duration regression: ${cases.length} assertions passed`);
