#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { formatDuration } = require('../public/js/components/format.js');

assert.strictEqual(formatDuration(45 / 60), '45');
assert.strictEqual(formatDuration(3 + 12 / 60), '3 h 12');
assert.strictEqual(formatDuration(3), '3 h');
console.log('format-duration regression: 3 assertions passed');
