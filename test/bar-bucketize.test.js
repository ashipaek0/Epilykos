#!/usr/bin/env node
/**
 * Epilykos Slice 1 — barCardLogic bucketize fixtures (pure logic, no DOM).
 *
 * Run:  node test/bar-bucketize.test.js   (also picked up by `npm test`)
 *
 * Loads the real public/js/components/barCardLogic.js source as a `data:` URL
 * ES module (same pattern as tests/text-metric-card.test.js — the module has
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
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((label || 'value') + ': expected ' + b + ', got ' + a);
}
function ok(cond, label) { if (!cond) throw new Error(label || 'expected truthy'); }

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'components', 'barCardLogic.js');
const H = 60 * 60 * 1000;

(async function main() {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  if (/(^|\n)\s*import\s/.test(src)) {
    console.error('barCardLogic.js gained an import; the data:-URL loader can no longer resolve it.');
    process.exit(1);
  }
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const { bucketize, bucketizeCapped, MAX_BARS, BUCKET_MS, normalizeRange, normalizeBucket, rangeToHours, bucketToMs } = mod;

  console.log('bar bucketize — sums / avgs / agg modes');
  const T0 = 1700000000000; // arbitrary fixed epoch ms
  const b0 = Math.floor(T0 / H) * H;
  check('avg of two points in one bucket', () => {
    const out = bucketize([{ timestamp: T0, value: 10 }, { timestamp: T0 + 1000, value: 20 }], H, 'avg');
    eq(out.length, 1); eq(out[0].t, b0); eq(out[0].value, 15);
  });
  check('sum of two points in one bucket', () => {
    const out = bucketize([{ timestamp: T0, value: 10 }, { timestamp: T0 + 1000, value: 20 }], H, 'sum');
    eq(out.length, 1); eq(out[0].value, 30);
  });
  check('min / max / last', () => {
    const pts = [{ timestamp: T0, value: 10 }, { timestamp: T0 + 1, value: 30 }, { timestamp: T0 + 2, value: 20 }];
    eq(bucketize(pts, H, 'min')[0].value, 10);
    eq(bucketize(pts, H, 'max')[0].value, 30);
    eq(bucketize(pts, H, 'last')[0].value, 20);
  });
  check('default agg is avg (omitted + unknown)', () => {
    const pts = [{ timestamp: T0, value: 10 }, { timestamp: T0 + 1, value: 20 }];
    eq(bucketize(pts, H)[0].value, 15, 'omitted agg');
    eq(bucketize(pts, H, 'bogus')[0].value, 15, 'unknown agg');
  });
  check('points across two buckets stay separate and sorted', () => {
    const out = bucketize([{ timestamp: T0 + H + 5, value: 2 }, { timestamp: T0, value: 1 }], H, 'sum');
    eq(out.length, 2);
    ok(out[0].t < out[1].t, 'not sorted');
    eq(out[0].value, 1); eq(out[1].value, 2);
  });

  console.log('bar bucketize — boundaries / gaps / empty / non-numeric');
  check('point exactly on a boundary lands in that bucket (floor)', () => {
    const edge = Math.ceil(T0 / H) * H; // exact bucket start
    const out = bucketize([{ timestamp: edge, value: 7 }], H, 'sum');
    eq(out.length, 1); eq(out[0].t, edge); eq(out[0].value, 7);
  });
  check('point 1ms before a boundary lands in the earlier bucket', () => {
    const edge = Math.ceil(T0 / H) * H;
    const out = bucketize([{ timestamp: edge - 1, value: 7 }], H, 'sum');
    eq(out.length, 1); eq(out[0].t, edge - H);
  });
  check('gaps: empty buckets are omitted, neighbours intact', () => {
    const out = bucketize([
      { timestamp: b0 + 1, value: 1 },
      { timestamp: b0 + 3 * H + 1, value: 4 },
    ], H, 'sum');
    eq(out.length, 2);
    eq(out[0].t, b0); eq(out[1].t, b0 + 3 * H);
  });
  check('empty input -> [] (also non-array)', () => {
    deepEq(bucketize([], H), []);
    deepEq(bucketize(null, H), []);
    deepEq(bucketize(undefined, H), []);
    deepEq(bucketize('nope', H), []);
  });
  check('all non-numeric values -> []', () => {
    deepEq(bucketize([{ timestamp: T0, value: 'abc' }, { timestamp: T0, value: null }], H), []);
  });
  check('numeric strings coerce; junk/NaN/Infinity/objects skipped', () => {
    const out = bucketize([
      { timestamp: T0, value: '10' },
      { timestamp: T0 + 1, value: '  5.5 ' },
      { timestamp: T0 + 2, value: 'abc' },
      { timestamp: T0 + 3, value: '' },
      { timestamp: T0 + 4, value: '   ' },
      { timestamp: T0 + 5, value: NaN },
      { timestamp: T0 + 6, value: Infinity },
      { timestamp: T0 + 7, value: { a: 1 } },
      { timestamp: T0 + 8, value: null },
      { timestamp: T0 + 9, value: undefined },
    ], H, 'sum');
    eq(out.length, 1); eq(out[0].value, 15.5);
  });
  check('non-finite timestamps skipped', () => {
    const out = bucketize([
      { timestamp: T0, value: 1 },
      { timestamp: NaN, value: 99 },
      { timestamp: undefined, value: 99 },
      { value: 99 },
      null,
    ], H, 'sum');
    eq(out.length, 1); eq(out[0].value, 1);
  });
  check('invalid bucketMs falls back to 1h', () => {
    for (const bad of [0, -5, NaN, undefined, null]) {
      const out = bucketize([{ timestamp: T0, value: 3 }], bad, 'sum');
      eq(out.length, 1, 'bucketMs=' + String(bad)); eq(out[0].t, b0, 'bucketMs=' + String(bad));
    }
  });

  console.log('bar bucketizeCapped — DOM cap');
  check('under the cap: passthrough, coarsened=false', () => {
    const r = bucketizeCapped([{ timestamp: T0, value: 1 }], H, 'avg');
    eq(r.coarsened, false); eq(r.bucketMs, H); eq(r.bars.length, 1);
  });
  check('over the cap: coarsens until bars fit', () => {
    const pts = [];
    for (let i = 0; i < MAX_BARS + 50; i++) pts.push({ timestamp: b0 + i * H, value: 1 });
    const r = bucketizeCapped(pts, H, 'sum');
    eq(r.coarsened, true);
    ok(r.bucketMs > H, 'bucket width did not grow');
    ok(r.bars.length <= MAX_BARS, 'still over cap: ' + r.bars.length);
  });

  console.log('bar range/bucket helpers');
  check('normalizeRange / normalizeBucket fall back on junk', () => {
    eq(normalizeRange('7d'), '7d'); eq(normalizeRange('xx'), '24h'); eq(normalizeRange(undefined), '24h');
    eq(normalizeBucket('15m'), '15m'); eq(normalizeBucket('xx'), '1h'); eq(normalizeBucket(null), '1h');
  });
  check('rangeToHours / bucketToMs', () => {
    eq(rangeToHours('24h'), 24); eq(rangeToHours('7d'), 168); eq(rangeToHours('xx'), 24);
    eq(bucketToMs('1h'), BUCKET_MS['1h']); eq(bucketToMs('xx'), BUCKET_MS['1h']);
  });

  console.log('');
  console.log('bar-bucketize: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('bar-bucketize test crashed: ' + (e && e.stack || e));
  process.exit(1);
});
