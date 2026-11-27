'use strict';
const checks = require('./_checks');
const assert = require('assert');
const fs = require('fs');
const shell = fs.readFileSync('public/js/components/forecastShell.js', 'utf8');
const render = fs.readFileSync('public/js/forecast.js', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8');
assert.match(shell, /<div class="fc-today-value">-- kWh<span class="fc-today-remaining" hidden>remaining<\/span><\/div>/,
  'remaining has its own secondary label beside the value');
assert.match(render, /const remainingEl = q\('\.fc-today-remaining'\);[\s\S]{0,180}remainingEl\.hidden = remaining == null;/,
  'label is shown only when a remaining value exists');
assert.match(render, /if \(produced != null\) sub\.push\([\s\S]{0,100}if \(expected != null\) sub\.push\(/,
  'produced and expected remain on the subline without a leading separator');
assert.match(render, /const expected = produced != null && remaining != null \? produced \+ remaining : total;/,
  'expected is produced plus the forecast still to come, so the figures add up');
assert.match(css, /\.fc-today-value\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*\}/,
  'value row can wrap at narrow widths');
assert.match(css, /\.fc-today-remaining\s*\{[^}]*font-size:[^}]*color:/,
  'remaining label is visually secondary');
console.log('forecast-today-label: 6 checks passed');
checks.done();
