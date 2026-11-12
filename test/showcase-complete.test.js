'use strict';
const checks = require('./_checks');
// The card showcase shows one of every dashboard card. It had fallen behind (the Daily peak and Histogram cards were missing),
// so this keeps the two lists together: a card added to the editor's library must be added to the showcase too.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const catalog = [...read('public/js/editor-catalog.js').matchAll(/^\s*'([a-z0-9-]+)':\s*\{ group:/gm)].map(m => m[1]);
  const shown = [...read('private/js/showcase-layout.js').matchAll(/\{ type: '([a-z0-9-]+)'/g)].map(m => m[1]);
  assert.ok(catalog.length > 40, 'found the library');
  assert.deepStrictEqual(catalog.filter(t => !shown.includes(t)), [], 'every card in the editor\'s library is in the showcase');
  assert.deepStrictEqual(shown.filter(t => !catalog.includes(t)), [], 'and the showcase has nothing the library does not');
  assert.strictEqual(new Set(shown).size, shown.length, 'once each (each has its own anchor on the page)');

  // The options to try belong to cards that are shown, and the cards with settings added since have theirs.
  const src = read('private/js/showcase.js');
  const optionsBlock = src.slice(src.indexOf('const OPTIONS = {'), src.indexOf('const CHART_TYPES'));
  const optionKeys = [...optionsBlock.matchAll(/^\s*'([a-z0-9-]+)':/gm)].map(m => m[1]);
  assert.deepStrictEqual(optionKeys.filter(t => !shown.includes(t)), [], 'options only for cards that are shown');
  for (const t of ['peak-bars', 'peak-histogram', 'bar-gauge', 'bar-gauge-retro']) assert.ok(optionKeys.includes(t), `${t} has options to try`);
  assert.match(src, /const BAR_LOOK = \[pick\('orientation'[\s\S]*?pick\('barEnds'/, 'the bar gauges\' orientation and bar ends');
  for (const t of ['button-card', 'switch-block', 'state-select', 'slider-card', 'rotary-card']) assert.match(optionsBlock, new RegExp(`'${t}': \\[[^\\n]*pick\\('layout'`), `${t} can try its layouts`);

  // The made-up data for the Peak cards, answered where the cards ask for it.
  const api = read('private/js/showcase-api.js');
  assert.match(api, /'\/api\/peaks': q => data\.solarPeaks\(/); assert.match(api, /'\/api\/histogram': q => data\.solarHistogram\(/);
  const D = await import(pathToFileURL(path.join(__dirname, '..', 'private/js/showcase-data.js')).href);
  const now = Date.UTC(2026, 10, 11, 12, 0, 0);
  const peaks = D.solarPeaks(30, now);
  assert.strictEqual(peaks.days.length, 30); assert.strictEqual(peaks.source, 'solar'); assert.strictEqual(peaks.unit, 'W');
  assert.ok(peaks.daysWithData >= 25, 'the made-up home has solar on most of its days');
  for (const d of peaks.days) assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
  const values = peaks.days.map(d => d.value).filter(v => v !== null);
  assert.ok(values.every(v => v >= 0 && v <= 5000), 'no more than the array can make');
  assert.strictEqual(peaks.highest.value, Math.max(...values)); assert.ok(peaks.median > 0 && peaks.median <= peaks.highest.value);
  const byPeak = D.solarHistogram(30, 'peaks', 10, false, now);
  assert.strictEqual(byPeak.mode, 'peaks'); assert.strictEqual(byPeak.total, values.length, 'every day with a peak is counted once');
  assert.strictEqual(byPeak.bins.reduce((a, b) => a + b.count, 0), values.length);
  assert.ok(byPeak.bins.every((b, i, a) => b.to > b.from && (i === 0 || b.from === a[i - 1].to)), 'bands follow one another');
  const byTime = D.solarHistogram(30, 'time', 10, false, now);
  assert.strictEqual(byTime.mode, 'time'); assert.strictEqual(byTime.nightBelowWatts, 10); assert.strictEqual(byTime.bins[0].from, 0, 'hours are counted from zero');
  assert.ok(byTime.total > 0 && byTime.total < 30 * 14, 'a few hours of daylight a day');
  const withNight = D.solarHistogram(30, 'time', 10, true, now);
  assert.ok(withNight.total > byTime.total, 'night included adds the hours without sun'); assert.strictEqual(withNight.nightBelowWatts, 0);
  console.log('ok - the showcase has every card, their options, and data for the Peak cards');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
