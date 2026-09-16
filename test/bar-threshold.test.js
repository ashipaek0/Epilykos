#!/usr/bin/env node
/**
 * Epilykos Slice 3 — bar-threshold fixtures (value computation + band math).
 *
 * Run:  node test/bar-threshold.test.js   (also picked up by `npm test`)
 *
 * Loads the real public/js/components/barThresholdCard.js source with its
 * single `from './barCardLogic.js'` import stripped and the real
 * barCardLogic.js source prepended, as a `data:` URL ES module (Slice 2
 * pattern — both modules are import-free after the strip).
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

/* Minimal document stub: only what renderThresholdBar touches. */
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
global.document = { createElement() { return fakeEl(); } };

const LOGIC_PATH = path.join(__dirname, '..', 'public', 'js', 'components', 'barCardLogic.js');
const CARD_PATH = path.join(__dirname, '..', 'public', 'js', 'components', 'barThresholdCard.js');
const H = 60 * 60 * 1000;

function genPoints(startMs, count, stepMs, valueFn) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ timestamp: startMs + i * stepMs, value: valueFn(i) });
  return out;
}

(async function main() {
  const logicSrc = fs.readFileSync(LOGIC_PATH, 'utf8');
  let cardSrc = fs.readFileSync(CARD_PATH, 'utf8');
  if (/(^|\n)\s*import\s/.test(logicSrc)) {
    console.error('barCardLogic.js gained an import; the data:-URL loader can no longer resolve it.');
    process.exit(1);
  }
  const stripped = cardSrc.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/, '');
  if (stripped === cardSrc) {
    console.error('barThresholdCard.js import line not found — expected one `from ...` import to strip.');
    process.exit(1);
  }
  const mod = await import('data:text/javascript;base64,' + Buffer.from(logicSrc + '\n' + stripped, 'utf8').toString('base64'));
  const { computeDisplayValue, normalizeThresholdConfig, bandsForValues,
    buildBarThresholdCard, renderThresholdBar,
    resolveBand, percentileBands, WARM_PALETTE, EMPTY_TEXT, NO_METRIC_TEXT } = mod;

  console.log('bar-threshold — value computation');
  check('last agg returns most recent bucket value', () => {
    const pts = genPoints(Date.now() - 3600000, 10, 60000, i => i + 1);
    const { value } = computeDisplayValue(pts, { valueAgg: 'last', bandMode: 'percentile', bucket: '1h', range: '24h', bands: [] });
    eq(value, 10, 'last value');
  });
  check('avg agg returns mean of buckets', () => {
    const pts = genPoints(Date.now() - 3600000, 10, 60000, () => 10);
    const { value } = computeDisplayValue(pts, { valueAgg: 'avg', bandMode: 'percentile', bucket: '1h', range: '24h', bands: [] });
    eq(value, 10, 'avg value');
  });
  check('empty points -> null value + empty bands', () => {
    const { value, bands } = computeDisplayValue([], { valueAgg: 'last', bandMode: 'percentile', bucket: '1h', range: '24h', bands: [] });
    eq(value, null, 'null value');
    eq(bands.length, 0, 'empty bands');
  });
  check('non-numeric points skipped, last valid used', () => {
    const start = Date.now() - 3600000;
    const pts = [
      { timestamp: start, value: '10' },
      { timestamp: start + 60000, value: 'not-a-number' },
      { timestamp: start + 120000, value: 20 },
      { timestamp: start + 180000, value: null }
    ];
    const { value } = computeDisplayValue(pts, { valueAgg: 'last', bandMode: 'percentile', bucket: '1h', range: '24h', bands: [] });
    eq(value, 20, 'last valid numeric');
  });

  console.log('bar-threshold — fixed vs percentile bands');
  check('fixed bands preserved verbatim', () => {
    const pts = genPoints(Date.now() - 3600000, 10, 60000, i => i + 1);
    const cfg = { valueAgg: 'last', bandMode: 'fixed', bucket: '1h', range: '24h', bands: [{ to: 5, color: '#red' }, { to: 15, color: '#green' }] };
    const { bands } = computeDisplayValue(pts, cfg);
    eq(bands.length, 2, 'two fixed bands');
    eq(bands[0].color, '#red', 'band 1 colour');
    eq(bands[1].color, '#green', 'band 2 colour');
  });
  check('percentile derives terciles (33/66/max) from history', () => {
    const pb = percentileBands([1, 2, 3, 4, 5, 6, 7, 8, 9], WARM_PALETTE);
    eq(pb.length, 3, 'three bands');
    eq(pb[0].to, 4, '33rd percentile');
    eq(pb[1].to, 7, '66th percentile');
    eq(pb[2].to, 9, 'max');
  });
  check('percentile empty input -> []', () => eq(percentileBands([], WARM_PALETTE).length, 0));
  check('percentile single value -> three identical bands', () => {
    const pb = percentileBands([5], WARM_PALETTE);
    eq(pb.length, 3);
    eq(pb[0].to, 5); eq(pb[1].to, 5); eq(pb[2].to, 5);
  });
  check('bandsForValues empty -> warm default fallback', () => {
    const bands = bandsForValues([], { bandMode: 'percentile', bands: [] });
    ok(bands.length >= 1, 'at least one default band');
  });

  console.log('bar-threshold — band resolution + marker colour');
  check('value on boundary picks that band (<=)', () => {
    const bands = [{ to: 5, color: '#a' }, { to: 10, color: '#b' }, { to: 20, color: '#c' }];
    eq(resolveBand(5, bands), '#a', 'on boundary');
    eq(resolveBand(6, bands), '#b', 'between');
    eq(resolveBand(20, bands), '#c', 'on max');
    eq(resolveBand(25, bands), '#c', 'over max clamps to last');
  });
  check('null / empty -> empty string', () => {
    const bands = [{ to: 5, color: '#a' }];
    eq(resolveBand(null, bands), '');
    eq(resolveBand(5, []), '');
  });
  check('string `to` parsed, invalid `to` skipped', () => {
    const bands = [{ to: '5', color: '#a' }, { to: 'junk', color: '#b' }, { to: 15, color: '#c' }];
    eq(resolveBand(3, bands), '#a', 'string to');
    eq(resolveBand(10, bands), '#c', 'invalid skipped');
  });
  check('marker colour = resolveBand(value)', () => {
    const bands = [{ to: 5, color: '#low' }, { to: 15, color: '#med' }, { to: 30, color: '#high' }];
    eq(resolveBand(3, bands), '#low');
    eq(resolveBand(10, bands), '#med');
    eq(resolveBand(25, bands), '#high');
  });

  console.log('bar-threshold — fill math (clamp)');
  check('above max clamps to 100%', () => {
    const pct = Math.max(0, Math.min(100, ((25 - 0) / (20 - 0)) * 100));
    eq(pct, 100);
  });
  check('below min clamps to 0%', () => {
    const pct = Math.max(0, Math.min(100, ((-5 - 0) / (20 - 0)) * 100));
    eq(pct, 0);
  });

  console.log('bar-threshold — config normalization');
  check('defaults: last / percentile / 24h / 1h', () => {
    const cfg = normalizeThresholdConfig({});
    eq(cfg.valueAgg, 'last', 'valueAgg');
    eq(cfg.bandMode, 'percentile', 'bandMode');
    eq(cfg.range, '24h', 'range');
    eq(cfg.bucket, '1h', 'bucket');
  });
  check('fixed config passes through', () => {
    const cfg = normalizeThresholdConfig({ valueAgg: 'avg', bandMode: 'fixed', range: '7d', bucket: '15m', bands: [{ to: 1, color: '#x' }] });
    eq(cfg.valueAgg, 'avg');
    eq(cfg.bandMode, 'fixed');
    eq(cfg.range, '7d');
    eq(cfg.bucket, '15m');
    eq(cfg.bands.length, 1);
  });

  console.log('bar-threshold — DOM render');
  check('buildBarThresholdCard structure (stub DOM)', () => {
    const card = buildBarThresholdCard({ id: 't1', config: { metric: 'battery_soc' } });
    ok(card.className.indexOf('bar-threshold-card') !== -1, 'card class');
    ok(card.dataset.barConfig.indexOf('battery_soc') !== -1, 'config serialized');
    eq(card.children.length, 3, 'title + wrapper + value');
  });
  check('no-metric block shows placeholder', () => {
    const card = buildBarThresholdCard({ id: 't2', config: {} });
    const valueEl = card.children[2];
    eq(valueEl.textContent, NO_METRIC_TEXT, 'placeholder text');
  });
  check('renderThresholdBar null value -> empty state, no throw', () => {
    const wrap = fakeEl(), val = fakeEl();
    renderThresholdBar(wrap, val, [], null);
    eq(val.textContent, EMPTY_TEXT, 'empty text');
    eq(wrap.children.length, 0, 'no segments');
  });
  check('renderThresholdBar renders band segments + marker', () => {
    const wrap = fakeEl(), val = fakeEl();
    const bands = [{ to: 5, color: '#low' }, { to: 15, color: '#med' }, { to: 30, color: '#high' }];
    renderThresholdBar(wrap, val, bands, 10);
    eq(wrap.children.length, 4, '3 segments + marker');
    ok(val.textContent !== EMPTY_TEXT, 'value text set');
    eq(val.style.color, '#med', 'marker band colour');
  });
  check('renderThresholdBar above max clamps marker at 100%', () => {
    const wrap = fakeEl(), val = fakeEl();
    const bands = [{ to: 5, color: '#low' }, { to: 30, color: '#high' }];
    renderThresholdBar(wrap, val, bands, 99);
    const marker = wrap.children[wrap.children.length - 1];
    eq(marker.style.left, '100%', 'clamped');
    eq(val.style.color, '#high', 'last band colour');
  });

  console.log('\nbar-threshold: ' + passes + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
})().catch(e => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1); });
