#!/usr/bin/env node
/**
 * Epilykos Slice 2 — bar-stacked fixtures (stacking logic + render order).
 *
 * Run:  node test/bar-stacked.test.js   (also picked up by `npm test`)
 *
 * Loads the real public/js/components/barStackedCard.js source with its
 * single `from './barCardLogic.js'` import stripped and the real
 * barCardLogic.js source prepended, as a `data:` URL ES module (extends the
 * Slice 1 data:-URL pattern — both modules are import-free after the strip).
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

/* Minimal document stub: only what renderStackedBars touches. */
function fakeEl() {
  return {
    children: [],
    style: {},
    dataset: {},
    className: '',
    textContent: '',
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); return c; },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    querySelector() { return null; }
  };
}

const LOGIC_PATH = path.join(__dirname, '..', 'public', 'js', 'components', 'barCardLogic.js');
const CARD_PATH = path.join(__dirname, '..', 'public', 'js', 'components', 'barStackedCard.js');
const H = 60 * 60 * 1000;

(async function main() {
  const logicSrc = fs.readFileSync(LOGIC_PATH, 'utf8');
  let cardSrc = fs.readFileSync(CARD_PATH, 'utf8');
  if (/(^|\n)\s*import\s/.test(logicSrc)) {
    console.error('barCardLogic.js gained an import; the data:-URL loader can no longer resolve it.');
    process.exit(1);
  }
  const stripped = cardSrc.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/, '');
  if (stripped === cardSrc) {
    console.error('barStackedCard.js import line not found — expected one `from ...` import to strip.');
    process.exit(1);
  }
  const mod = await import('data:text/javascript;base64,' + Buffer.from(logicSrc + '\n' + stripped, 'utf8').toString('base64'));
  const { stackSeries, stackSeriesCapped, normalizeStackedConfig, normalizeAgg,
    renderStackedBars, EMPTY_TEXT, NO_METRIC_TEXT, MAX_BARS, WARM_PALETTE, bucketize } = mod;

  const T0 = 1700000000000;
  const b0 = Math.floor(T0 / H) * H;

  console.log('bar-stacked — shared edges across cadences');
  check('15m-cadence + hourly series share one 1h edge set', () => {
    const a = [];
    for (let i = 0; i < 12; i++) a.push({ timestamp: b0 + i * 15 * 60 * 1000 + 1, value: 1 });
    const b = [
      { timestamp: b0 + 1, value: 10 },
      { timestamp: b0 + H + 1, value: 10 },
      { timestamp: b0 + 2 * H + 1, value: 10 }
    ];
    const r = stackSeries([a, b], H, 'avg');
    deepEq(r.edges, [b0, b0 + H, b0 + 2 * H], 'edges');
    eq(r.rows.length, 3);
    for (const row of r.rows) {
      eq(row.values.length, 2, 'series order width');
      eq(row.values[0], 1, 'avg of 15m ones');
      eq(row.values[1], 10, 'hourly value');
      eq(row.total, 11, 'total');
    }
  });
  check('union of disjoint timestamps, sorted', () => {
    const r = stackSeries([
      [{ timestamp: b0 + 2 * H + 1, value: 5 }],
      [{ timestamp: b0 + 1, value: 7 }]
    ], H, 'sum');
    deepEq(r.edges, [b0, b0 + 2 * H]);
  });

  console.log('bar-stacked — zero-fill / sum preservation / order');
  check('missing series in a bucket is a zero, total intact', () => {
    const r = stackSeries([
      [{ timestamp: b0 + 1, value: 4 }, { timestamp: b0 + H + 1, value: 4 }, { timestamp: b0 + 2 * H + 1, value: 4 }],
      [{ timestamp: b0 + H + 1, value: 6 }]
    ], H, 'sum');
    eq(r.rows.length, 3);
    deepEq(r.rows[0].values, [4, 0]);
    deepEq(r.rows[1].values, [4, 6]);
    deepEq(r.rows[2].values, [4, 0]);
    eq(r.rows[0].total, 4); eq(r.rows[1].total, 10); eq(r.rows[2].total, 4);
  });
  check('per-bucket totals equal the sum of individual bucketize values', () => {
    const A = [{ timestamp: b0 + 1, value: 3 }, { timestamp: b0 + 2, value: 9 }, { timestamp: b0 + H + 1, value: 5 }];
    const B = [{ timestamp: b0 + 3, value: 2 }, { timestamp: b0 + H + 1, value: 8 }];
    const r = stackSeries([A, B], H, 'sum');
    const ea = new Map(bucketize(A, H, 'sum').map(x => [x.t, x.value]));
    const eb = new Map(bucketize(B, H, 'sum').map(x => [x.t, x.value]));
    for (const row of r.rows) {
      eq(row.total, (ea.get(row.t) || 0) + (eb.get(row.t) || 0), 'sum preserved @' + row.t);
    }
  });
  check('values stay in series order (no rotation)', () => {
    const r = stackSeries([
      [{ timestamp: b0 + 1, value: 1 }],
      [{ timestamp: b0 + 1, value: 2 }],
      [{ timestamp: b0 + 1, value: 3 }]
    ], H, 'sum');
    deepEq(r.rows[0].values, [1, 2, 3]);
  });
  check('default agg is avg when omitted', () => {
    const r = stackSeries([[{ timestamp: b0 + 1, value: 10 }, { timestamp: b0 + 2, value: 20 }]], H);
    eq(r.rows[0].values[0], 15);
  });

  console.log('bar-stacked — single-series / empty-all / cap');
  check('single series degrades to plain bucketize values', () => {
    const pts = [{ timestamp: b0 + 1, value: 2 }, { timestamp: b0 + H + 1, value: 5 }];
    const r = stackSeries([pts], H, 'sum');
    const plain = bucketize(pts, H, 'sum');
    eq(r.rows.length, plain.length);
    for (let i = 0; i < plain.length; i++) {
      eq(r.rows[i].values[0], plain[i].value, 'bucket ' + i);
      eq(r.rows[i].total, plain[i].value, 'total == value ' + i);
    }
  });
  check('empty-all histories -> no edges, no rows', () => {
    const r = stackSeries([[], []], H, 'avg');
    deepEq(r.edges, []); deepEq(r.rows, []);
    const r2 = stackSeries([], H, 'avg');
    deepEq(r2.edges, []); deepEq(r2.rows, []);
  });
  check('over the cap: coarsens until columns fit', () => {
    const pts = [];
    for (let i = 0; i < MAX_BARS + 50; i++) pts.push({ timestamp: b0 + i * H, value: 1 });
    const r = stackSeriesCapped([pts, pts.map(p => ({ timestamp: p.timestamp, value: 2 }))], H, 'sum');
    eq(r.coarsened, true);
    ok(r.bucketMs > H, 'bucket width did not grow');
    ok(r.edges.length <= MAX_BARS, 'still over cap: ' + r.edges.length);
    for (const row of r.rows) eq(row.values.length, 2, 'width kept after coarsen');
  });

  console.log('bar-stacked — config normalize');
  check('junk range/bucket/agg fall back to 24h/1h/avg', () => {
    const c = normalizeStackedConfig({ metrics: [{ metric: 'm' }], range: 'xx', bucket: 'yy', agg: 'zz' });
    eq(c.range, '24h'); eq(c.bucket, '1h'); eq(c.agg, 'avg');
  });
  check('normalizeAgg accepts the five modes only', () => {
    for (const m of ['avg', 'sum', 'min', 'max', 'last']) eq(normalizeAgg(m), m, m);
    eq(normalizeAgg('bogus'), 'avg'); eq(normalizeAgg(undefined), 'avg');
  });
  check('series colours pass through in order', () => {
    const c = normalizeStackedConfig({ metrics: [
      { label: 'A', metric: 'a', color: '#111111' },
      { label: 'B', metric: 'b', color: '#222222' }
    ] });
    deepEq(c.series.map(s => s.color), ['#111111', '#222222']);
  });
  check('missing colours cycle WARM_PALETTE in order', () => {
    const c = normalizeStackedConfig({ metrics: [{ metric: 'a' }, { metric: 'b' }, { metric: 'c' }] });
    deepEq(c.series.map(s => s.color), [WARM_PALETTE[0], WARM_PALETTE[1], WARM_PALETTE[2]]);
  });
  check('label defaults to metric; empty-metric rows filtered', () => {
    const c = normalizeStackedConfig({ metrics: [{ metric: 'a' }, { label: 'x', metric: '' }, { label: 'B', metric: 'b' }] });
    eq(c.series.length, 2);
    eq(c.series[0].label, 'a');
    eq(c.series[1].label, 'B');
  });

  console.log('bar-stacked — render order / empty (stubbed DOM)');
  global.document = { createElement: () => fakeEl() };
  check('columns == rows, segments in series order with passthrough colours', () => {
    const body = fakeEl(), status = fakeEl(), legend = fakeEl();
    const series = [
      { label: 'A', metric: 'a', color: '#111111' },
      { label: 'B', metric: 'b', color: '#222222' }
    ];
    const stacked = stackSeries([
      [{ timestamp: b0 + 1, value: 4 }, { timestamp: b0 + H + 1, value: 4 }],
      [{ timestamp: b0 + H + 1, value: 6 }]
    ], H, 'sum');
    renderStackedBars(body, status, legend, stacked, series);
    eq(body.children.length, 2, 'columns');
    const col0 = body.children[0];
    eq(col0.children.length, 2, 'segments incl. zero-fill');
    ok(col0.children[0].style.cssText.includes('#111111'), 'seg0 colour');
    ok(col0.children[1].style.cssText.includes('#222222'), 'seg1 colour');
    ok(col0.children[1].style.cssText.includes('height:0.0%'), 'missing segment is zero-height');
    eq(status.style.display, 'none', 'status hidden');
    eq(legend.children.length, 2, 'legend entries');
  });
  check('empty stack -> EMPTY_TEXT, no columns', () => {
    const body = fakeEl(), status = fakeEl(), legend = fakeEl();
    renderStackedBars(body, status, legend, stackSeries([[], []], H), []);
    eq(body.children.length, 0);
    eq(status.textContent, EMPTY_TEXT);
  });
  check('NO_METRIC_TEXT constant is non-empty', () => {
    ok(typeof NO_METRIC_TEXT === 'string' && NO_METRIC_TEXT.length > 0, 'placeholder');
  });

  console.log('bar-stacked — data path stays client-side (no ?bucket param)');
  check('fetch uses metric+hours only, never a bucket query param', () => {
    const src = fs.readFileSync(CARD_PATH, 'utf8');
    ok(src.includes('/api/metrics/history?metric='), 'history endpoint');
    ok(src.includes('&hours='), 'hours param');
    ok(!src.includes('?bucket') && !src.includes('&bucket'), 'bucket must never be a query param');
  });

  console.log('');
  console.log('bar-stacked: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('bar-stacked test crashed: ' + (e && e.stack || e));
  process.exit(1);
});
