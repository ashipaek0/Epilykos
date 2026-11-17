'use strict';
const checks = require('./_checks');
// Device-card templates must not interpolate raw config values into attributes,
// and error text must not be interpolated raw into innerHTML (CodeQL js/xss-through-dom).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.js'), 'utf8');

const rawAttr = src.match(/value="\$\{device\.[a-z_]+\s*\|\|/g) || [];
assert.strictEqual(rawAttr.length, 0, 'raw device.* in value attribute: ' + rawAttr.join(', '));
const rawErr = src.match(/innerHTML\s*=\s*`[^`]*\$\{e\.message\}/g) || [];
assert.strictEqual(rawErr.length, 0, 'raw e.message in innerHTML');
checks.done();
