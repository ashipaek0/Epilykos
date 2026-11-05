'use strict';
const checks = require('./_checks');
// The Daily peak and Histogram cards (public/js/components/peakCharts.js): their settings are read safely,
// and they are wired into the dashboard, the editor's palette and the editor's settings form.
// The charts themselves were checked in a browser with 120 days of readings, in light and dark.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const { peakSettings } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/peakCharts.js')).href);

  // Settings: solar is in kW; a metric needs a name, and keeps its own unit and multiplier.
  assert.deepEqual(peakSettings({}), { source: 'solar', metric: '', scale: 0.001, unit: 'kW', days: 30, bins: 10, color: '', mode: 'peaks', includeNight: false });
  assert.equal(peakSettings({ source: 'metric' }).source, 'solar', 'a metric source without a metric falls back to solar');
  const m = peakSettings({ source: 'metric', metric: 'pv_peak_today', unit: 'W', scale: '0.001', days: 90 });
  assert.deepEqual([m.source, m.metric, m.unit, m.scale, m.days], ['metric', 'pv_peak_today', 'W', 0.001, 90]);
  assert.equal(peakSettings({ source: 'metric', metric: 'x', scale: 0 }).scale, 1, 'a zero multiplier is not used');
  assert.equal(peakSettings({ source: 'metric', metric: 'x', scale: 'abc' }).scale, 1);
  assert.equal(peakSettings({ days: 7 }).days, 30, 'only the offered ranges');
  assert.equal(peakSettings({ days: 365 }).days, 365);
  assert.equal(peakSettings({ bins: 2 }).bins, 4); assert.equal(peakSettings({ bins: 99 }).bins, 30); assert.equal(peakSettings({ bins: 'x' }).bins, 10);
  assert.equal(peakSettings({ color: '#f59e0b' }).color, '#f59e0b'); assert.equal(peakSettings({ color: 'red; x' }).color, '', 'only a hex colour');
  assert.equal(peakSettings({ mode: 'time' }).mode, 'time');
  assert.equal(peakSettings({ mode: 'time', source: 'metric', metric: 'x' }).mode, 'peaks', 'time at power is solar only');
  assert.equal(peakSettings({ unit: '<script>alert(1)</script>', source: 'metric', metric: 'x' }).unit.length <= 12, true, 'unit is short');
  console.log('ok - card settings');

  // Wired in.
  const index = read('public/js/components/index.js');
  assert.match(index, /import \{ buildPeakBars, buildPeakHistogram \} from '\.\/peakCharts\.js'/);
  assert.match(index, /'peak-bars': buildPeakBars/); assert.match(index, /'peak-histogram': buildPeakHistogram/);
  const catalog = read('public/js/editor-catalog.js');
  assert.match(catalog, /'peak-bars':\s+\{ group: 'charts', name: 'Daily peak'/); assert.match(catalog, /'peak-histogram':\s+\{ group: 'charts', name: 'Histogram'/);
  const editor = read('public/js/editor.js');
  for (const id of ['modal-pk-source', 'modal-pk-metric', 'modal-pk-unit', 'modal-pk-scale', 'modal-pk-days', 'modal-pk-mode', 'modal-pk-bins', 'modal-pk-night', 'modal-pk-color']) {
    assert.ok(editor.includes(`'${id}'`) || editor.includes(`"${id}"`), `the editor form has ${id}`);
    assert.ok(new RegExp(`getElementById\\('${id}'\\)`).test(editor), `and reads ${id}`);
  }
  assert.match(editor, /Pick the metric to chart, or choose solar power\./);
  assert.match(editor, /Bands: a whole number from 4 to 30\./);
  assert.match(read('public/cards.css'), /\.pk-range\[aria-pressed="true"\]/);
  // The cards use the energy day card's frame, so glass cards, square corners and the rest apply to them.
  const card = read('public/js/components/peakCharts.js');
  assert.equal((card.match(/energy-day-card pk-card/g) || []).length, 2);
  assert.match(read('public/glass.css'), /\.energy-day-card/);
  assert.match(card, /\/api\/peaks\?days=/); assert.match(card, /\/api\/histogram\?days=/);
  assert.ok(!/innerHTML\s*=\s*[^;]*\b(config|settings)\b\.(title|metric|unit)/.test(card.replace(/escapeHtml\([^)]*\)/g, '')), 'config text is escaped before it goes into markup');
  console.log('ok - wired into the dashboard, the palette and the editor');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
