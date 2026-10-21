'use strict';
const checks = require('./_checks');
// Settings > Appearance: "Square corners" beside "Transparent blocks" squares
// every dashboard card (checked in a browser too: on, no card or tile on the
// dashboard is rounded and the header keeps its corners; off, all as before).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const html = read('public/settings.html');
const row = html.split('\n').find(l => l.includes('id="transparent-blocks"'));
assert.ok(row && row.includes('id="square-corners" name="square_corners"'), 'the toggle sits on the transparency row');
assert.match(read('public/js/dashboard.js'), /classList\.toggle\('square-corners', cfg\.square_corners === 'true'\)/);
assert.match(read('routes/metrics.js'), /'transparent_blocks', 'square_corners'/, 'the dashboard is told the setting');
assert.match(read('server.js'), /'transparent_blocks', 'square_corners'/);
const css = read('public/style.css');
assert.match(css, /body\.square-corners #dashboard-container \{ --radius: 0px; \}/, 'scoped to the dashboard, not the header');
console.log('ok - square corners setting');

// Grid card: the bars fill the card's spare height, on a scale that fits the longest day.
const grid = read('public/js/components/gridCard.js'), cards = read('public/cards.css');
assert.match(grid, /Math\.min\(24, Math\.max\(6, Math\.ceil\(longest \/ 6\) \* 6\)\)/);
assert.match(grid, /d\.hours \/ scale \* 100/);
assert.match(cards, /\.ep-grid-days \{[^}]*flex: 1 1 64px; min-height: 64px; max-height: 240px;/);
assert.match(cards, /\.grid-card\.ep-card > \* \{ flex-shrink: 0; \}/);
console.log('ok - grid hours per day fill and scale');
checks.done();
