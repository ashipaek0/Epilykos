'use strict';
const checks = require('./_checks');
// The bar gauges (Bar gauge, Bar gauge segmented, each in rows or columns) scale with the card: the card is a size container,
// rows share its height and columns its width, and each bar is a share of its row or column. They used to be sized from the
// card's width alone, with hard pixel limits, so a bigger card only got more empty space and a smaller one clipped.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const css = read('public/cards.css');
const section = css.slice(css.indexOf('/* ── Bar gauges ─'), css.indexOf('/* ── History and threshold bars'));
assert.ok(section.length > 1000, 'the bar gauge styles are in one section');

// Sized from the card, both ways.
assert.match(section, /\.bar-gauge-card, \.bar-gauge-retro-card \{\s*\n\s*container-type: size;/, 'the card is a size container');
assert.match(section, /--bar-font: calc\(clamp\(0\.7rem, min\(100cqh \/ var\(--bars, 4\) \* 0\.36, 4\.4cqw\), 1\.6rem\) \* var\(--card-font-scale, 1\)\);/, 'text follows the row height');
assert.match(section, /\.bar-gauge-row, \.bg-retro-row \{[^}]*flex: 1 1 0; min-height: 0;/, 'rows share the card\'s height');
assert.match(section, /\.bar-gauge-track \{ align-self: center; height: clamp\(6px, 46%, 40px\) !important;/, 'a bar is a share of its row, not a fixed size');
assert.match(section, /\.bg-retro-segments \{ align-self: center; height: clamp\(8px, 52%, 44px\);/);
assert.match(section, /\.bg-retro-seg \{ height: 100% !important;/, 'a segment is as tall as its strip');
assert.ok(!/clamp\(10px, 3\.4cqi, 18px\)|clamp\(12px, 4cqi, 22px\)/.test(section), 'the old fixed bar sizes are gone');
assert.ok(!/gap: clamp\(8px, 3cqi, 16px\)/.test(section), 'and the fixed gap between rows');
// Columns: each bar a share of its column.
assert.match(section, /\.bar-gauge-card\.is-vertical \.bar-gauge-track \{[^}]*width: clamp\(12px, 46%, 140px\);/);
assert.match(section, /\.bar-gauge-retro-card\.is-vertical \.bg-retro-segments \{[^}]*width: clamp\(12px, 46%, 140px\); flex-direction: column-reverse; gap: clamp\(1px, 0\.9cqh, 5px\) !important;/, 'the gap between segments follows the height too');
assert.match(section, /--bar-font: calc\(clamp\(0\.55rem, min\(100cqw \/ var\(--bars, 4\) \* 0\.2, 100cqh \* 0\.09\), 1\.6rem\)/, 'column text follows the column width');
assert.match(section, /\.bar-gauge-card\.is-vertical \.bar-gauge-fill \{[^}]*border-radius: 0 !important;/, 'a short fill in a wide column is cut to the track, not a blob');
// Small cards: nothing squeezed away or spilling out.
assert.match(section, /@container \(max-height: 120px\) \{[\s\S]*?\.is-vertical :is\(\.bar-gauge-label, \.bg-retro-label\) \{ display: none; \}[\s\S]*?\.bg-retro-segments \{ gap: 0 !important; \}/, 'a short column card drops its labels and the gaps between segments');
assert.match(section, /\.is-vertical :is\(\.bar-gauge-value, \.bg-retro-value\) \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/, 'a value in a narrow column is cut, not spilled');
// Phones stack the blocks without a height of their own: each bar keeps one to be drawn in.
assert.match(section, /@media \(max-width: 768px\) \{\s*\n\s*\.bar-gauge-card, \.bar-gauge-retro-card \{ min-height: calc\(var\(--bars, 4\) \* 3\.2rem\); \}\s*\n\s*\.bar-gauge-card\.is-vertical, \.bar-gauge-retro-card\.is-vertical \{ min-height: 14rem; \}/);
// The look settings are untouched.
assert.match(section, /\.bar-ends-rounded/); assert.match(section, /\.bar-ends-square/); assert.match(section, /\.is-vertical \{\s*\n\s*flex-direction: row !important;/);

// The cards tell the styles how many bars they have.
for (const f of ['public/js/components/barGauge.js', 'public/js/components/barGaugeRetro.js']) {
  assert.match(read(f), /container\.style\.setProperty\('--bars', String\(rows\.length\)\);/, f);
}
console.log('ok - bar gauges are sized from the card, both ways');
checks.done();
