#!/usr/bin/env node
/**
 * Epilykos Slice 1 — barCardLogic band fixtures (pure logic, no DOM).
 *
 * Run:  node test/bar-bands.test.js   (also picked up by `npm test`)
 *
 * Loads the real public/js/components/barCardLogic.js source as a `data:` URL
 * ES module (same pattern as test/text-metric-card.test.js — the module has
 * ZERO imports so this resolves with nothing installed).
 */
'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
let passes = 0;
function check(name, fn) {
  try { fn(); passes++; console.log('  ✓ ' + name); }
  catch (e) { failures++; console.error('  ✗ ' + name + ' — ' + e.message); }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function ok(cond, label) { if (!cond) throw new Error(label || 'expected truthy'); }

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'components', 'barCardLogic.js');

(async function main() {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  if (/(^|\n)\s*import\s/.test(src)) {
    console.error('barCardLogic.js gained an import; the data:-URL loader can no longer resolve it.');
    process.exit(1);
  }
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const { resolveBand, percentileBands, WARM_PALETTE } = mod;

  const BANDS = [{ to: 10, color: 'c1' }, { to: 20, color: 'c2' }, { to: 30, color: 'c3' }];

  console.log('bar resolveBand — boundaries / over-max / null');
  check('value below first `to` -> first colour', () => eq(resolveBand(5, BANDS), 'c1'));
  check('value exactly on a boundary resolves to that band (<=)', () => {
    eq(resolveBand(10, BANDS), 'c1');
    eq(resolveBand(20, BANDS), 'c2');
    eq(resolveBand(30, BANDS), 'c3');
  });
  check('value between bands resolves to the next band up', () => eq(resolveBand(15, BANDS), 'c2'));
  check('value over max resolves to the last band colour', () => {
    eq(resolveBand(31, BANDS), 'c3');
    eq(resolveBand(1e9, BANDS), 'c3');
  });
  check('null / undefined / non-numeric value -> empty string', () => {
    eq(resolveBand(null, BANDS), '');
    eq(resolveBand(undefined, BANDS), '');
    eq(resolveBand('abc', BANDS), '');
    eq(resolveBand(NaN, BANDS), '');
    eq(resolveBand({}, BANDS), '');
  });
  check('numeric strings coerce', () => eq(resolveBand('15', BANDS), 'c2'));
  check('null / empty bands -> empty string (never throws)', () => {
    eq(resolveBand(5, null), '');
    eq(resolveBand(5, undefined), '');
    eq(resolveBand(5, []), '');
    eq(resolveBand(null, null), '');
  });
  check('band entries without a numeric `to` are skipped', () => {
    eq(resolveBand(5, [{ to: 'xx' }, { to: 10, color: 'c1' }]), 'c1');
  });
  check('band without a colour resolves to empty string', () => {
    eq(resolveBand(5, [{ to: 10 }]), '');
  });

  console.log('bar percentileBands — terciles / empty / single-value');
  check('WARM_PALETTE has the documented warm stops', () => {
    ok(Array.isArray(WARM_PALETTE) && WARM_PALETTE.length >= 3, 'palette too short');
  });
  check('terciles of 1..9: three ascending bands ending at the max', () => {
    const bands = percentileBands([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    eq(bands.length, 3);
    ok(bands[0].to <= bands[1].to && bands[1].to <= bands[2].to, 'bands not ascending: ' + JSON.stringify(bands));
    eq(bands[2].to, 9, 'last band must end at the max');
    eq(bands[0].color, WARM_PALETTE[0]);
    eq(bands[1].color, WARM_PALETTE[1]);
  });
  check('tercile cut points match the documented 1/3 + 2/3 ranks', () => {
    const bands = percentileBands([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    eq(bands[0].to, 4); // floor(9 * 1/3) = index 3 -> 4
    eq(bands[1].to, 7); // floor(9 * 2/3) = index 6 -> 7
  });
  check('empty / non-numeric input -> []', () => {
    eq(JSON.stringify(percentileBands([])), '[]');
    eq(JSON.stringify(percentileBands(null)), '[]');
    eq(JSON.stringify(percentileBands(['a', null, undefined])), '[]');
  });
  check('single value -> three bands all ending at that value', () => {
    const bands = percentileBands([42]);
    eq(bands.length, 3);
    eq(bands[0].to, 42); eq(bands[1].to, 42); eq(bands[2].to, 42);
  });
  check('non-numeric entries are filtered, numerics still banded', () => {
    const bands = percentileBands(['a', 10, null, 20, undefined, 30]);
    eq(bands.length, 3);
    eq(bands[2].to, 30);
  });
  check('numeric strings participate', () => {
    const bands = percentileBands(['10', '20', '30']);
    eq(bands.length, 3);
    eq(bands[2].to, 30);
  });
  check('custom palette (3+ colours) is honoured', () => {
    const bands = percentileBands([1, 2, 3], ['p1', 'p2', 'p3']);
    eq(bands[0].color, 'p1'); eq(bands[1].color, 'p2'); eq(bands[2].color, 'p3');
  });
  check('short palette falls back to WARM_PALETTE', () => {
    const bands = percentileBands([1, 2, 3], ['only']);
    eq(bands[0].color, WARM_PALETTE[0]);
  });
  check('resolveBand consumes percentileBands output end to end', () => {
    const bands = percentileBands([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    eq(resolveBand(1, bands), bands[0].color);
    eq(resolveBand(9, bands), bands[2].color);
    eq(resolveBand(100, bands), bands[2].color);
  });

  console.log('');
  console.log('bar-bands: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('bar-bands test crashed: ' + (e && e.stack || e));
  process.exit(1);
});
