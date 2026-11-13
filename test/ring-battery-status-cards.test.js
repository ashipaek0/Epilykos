'use strict';
const checks = require('./_checks');
// The Ring gauge, Battery and Status list cards: their options, the maths behind what they draw, and that each one is wired
// into the registry, the data refresh, the editor library, form and save, the showcase and the stylesheet. (Their drawing is
// checked in a browser.)
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const load = f => import(pathToFileURL(path.join(__dirname, '..', 'public/js/components', f)).href);

(async () => {
  // ── Ring gauge ──
  const R = await load('ringGauge.js');
  let o = R.ringOptions({});
  assert.deepStrictEqual(o.rings.map(r => r.metric), ['solar', 'consumption'], 'two rings by default');
  assert.strictEqual(o.showTracks, true); assert.strictEqual(o.title, '');
  o = R.ringOptions({ title: ' Energy ', showTracks: false, icon: 'mdi:flash', rings: [
    { label: 'A', metric: ' pv ', min: 0, max: 5000, color: '#ff0000' }, { label: 'B', metric: 'load', min: 10, max: 5, color: 'red' },
    { label: 'C', metric: 'soc', unit: '%', min: 'x', max: '', color: '#0f0' }, { label: 'D', metric: 'extra' }] });
  assert.strictEqual(o.title, 'Energy'); assert.strictEqual(o.showTracks, false); assert.strictEqual(o.rings.length, 3, 'at most three rings');
  assert.strictEqual(o.rings[0].metric, 'pv', 'a metric name is trimmed'); assert.strictEqual(o.rings[0].color, '#ff0000');
  assert.ok(o.rings[1].max > o.rings[1].min, 'a range that runs backwards is made valid'); assert.strictEqual(o.rings[1].color, 'var(--home, #38bdf8)', 'a colour that is not #rrggbb falls back to the palette');
  assert.strictEqual(o.rings[2].min, 0); assert.strictEqual(o.rings[2].max, 100, 'unreadable numbers fall back');
  assert.strictEqual(R.ringFraction(2500, 0, 5000), 0.5); assert.strictEqual(R.ringFraction(-5, 0, 5000), 0, 'clamped'); assert.strictEqual(R.ringFraction(9000, 0, 5000), 1);
  assert.strictEqual(R.ringFraction(undefined, 0, 5000), null); assert.strictEqual(R.ringFraction('n/a', 0, 5000), null); assert.strictEqual(R.ringFraction(5, 10, 10), null);
  assert.deepStrictEqual([0, 1, 2].map(R.ringRadius), [45, 36, 27], 'rings are 9 units apart, outer first');
  assert.ok(R.ringRadius(2) - R.RING_WIDTH / 2 > 20, 'the innermost ring leaves room in the middle');

  // ── Battery ──
  const B = await load('batteryCard.js');
  let b = B.batteryOptions({});
  assert.deepStrictEqual(b.metrics, { soc: 'battery_soc', current: 'battery_current' }); assert.strictEqual(b.title, 'Battery'); assert.strictEqual(b.showCurrent, true);
  assert.deepStrictEqual([b.lowAt, b.warnAt, b.currentMax, b.fillColor, b.chips.length], [20, 50, 100, '', 0]);
  b = B.batteryOptions({ title: '', metrics: { soc: ' soc2 ', current: 5 }, lowAt: 30, warnAt: 10, currentMax: -5, fillColor: 'blue', showCurrent: false,
    chips: [{ label: 'In', metric: 't1', color: '#abc' }, { label: 'x', metric: '' }, { metric: 't2' }, { metric: 't3' }, { metric: 't4' }, { metric: 't5' }] });
  assert.strictEqual(b.title, '', 'an empty title hides it'); assert.strictEqual(b.metrics.soc, 'soc2'); assert.strictEqual(b.metrics.current, 'battery_current', 'a non-text metric name falls back');
  assert.strictEqual(b.warnAt, 30, 'amber is never below red'); assert.strictEqual(b.currentMax, 100, 'a bad range falls back'); assert.strictEqual(b.fillColor, ''); assert.strictEqual(b.showCurrent, false);
  assert.deepStrictEqual(b.chips.map(c => c.metric), ['t1', 't2', 't3', 't4'], 'up to four readings, none without a metric'); assert.strictEqual(b.chips[0].color, '#abc');
  const bands = { lowAt: 20, warnAt: 50 };
  assert.deepStrictEqual([0, 20, 21, 50, 51, 100].map(v => B.fillBand(v, bands)), ['low', 'low', 'mid', 'mid', 'high', 'high']); assert.strictEqual(B.fillBand(undefined, bands), 'none'); assert.strictEqual(B.fillBand('x', bands), 'none');
  assert.strictEqual(B.currentPosition(100, 100), 0, '+max is the top'); assert.strictEqual(B.currentPosition(0, 100), 0.5); assert.strictEqual(B.currentPosition(-100, 100), 1, '-max is the bottom');
  assert.ok(Math.abs(B.currentPosition(4.7, 100) - 0.4765) < 1e-9, 'a little charging sits just above the middle'); assert.strictEqual(B.currentPosition(500, 100), 0, 'clamped'); assert.strictEqual(B.currentPosition(undefined, 100), null);

  // ── Status list ──
  const S = await load('statusList.js');
  const on = { when: 'on', limit: 0 }, above = { when: 'above', limit: 50 }, below = { when: 'below', limit: 20 };
  for (const v of ['on', 'ON', 'true', '1', 'yes', 'active', 'running', true, 1, 3.5, ' On ']) assert.strictEqual(S.isOn(v, on), true, 'on: ' + v);
  for (const v of ['off', 'false', '0', 'no', 'idle', false, 0, -1, 'something else']) assert.strictEqual(S.isOn(v, on), false, 'off: ' + v);
  for (const v of [undefined, null, '']) assert.strictEqual(S.isOn(v, on), null, 'no reading: ' + String(v));
  assert.strictEqual(S.isOn(60, above), true); assert.strictEqual(S.isOn(50, above), false, 'above is strictly above'); assert.strictEqual(S.isOn('75', above), true, 'a number sent as text');
  assert.strictEqual(S.isOn(10, below), true); assert.strictEqual(S.isOn(20, below), false); assert.strictEqual(S.isOn('on', above), null, 'text cannot be judged against a limit');
  let so = S.statusOptions({});
  assert.deepStrictEqual(so.rows, []); assert.strictEqual(so.showCount, false); assert.strictEqual(so.showValue, false);
  so = S.statusOptions({ title: 'Consumers', showCount: true, onColor: '#0f0', rows: [{ label: 'Boiler', metric: 'b', when: 'above', limit: '50' }, { label: 'No metric' }, { metric: 'z', when: 'sideways', limit: 'x', color: 'green' }, {}] });
  assert.strictEqual(so.rows.length, 3, 'a row needs a metric or a label'); assert.strictEqual(so.rows[0].limit, 50); assert.strictEqual(so.rows[2].when, 'on', 'an unknown rule is on'); assert.strictEqual(so.rows[2].limit, 0); assert.strictEqual(so.rows[2].color, '');
  assert.strictEqual(S.statusOptions({ rows: Array.from({ length: 20 }, (_, i) => ({ metric: 'm' + i })) }).rows.length, 12, 'at most twelve rows');
  // No word on the card is fixed: the count line and the on/off words are settings, English only by default
  assert.deepStrictEqual([so.countText, so.onText, so.offText], ['{on} of {total} on', 'On', 'Off']);
  so = S.statusOptions({ countText: ' {on} / {total} aktív ', onText: 'Be', offText: 'Ki' });
  assert.deepStrictEqual([so.countText, so.onText, so.offText], ['{on} / {total} aktív', 'Be', 'Ki'], 'any language, trimmed');
  assert.strictEqual(S.statusOptions({ onText: 'x'.repeat(40) }).onText.length, 16, 'kept short');
  assert.ok(!/Hungarian|Termel|Fogyaszt/.test(read('public/js/components/statusList.js') + read('public/js/components/ringGauge.js') + read('public/js/components/batteryCard.js')), 'no language of its own in the cards');
  const bsrc = read('public/js/components/batteryCard.js');
  assert.ok(/curEntry\.unit/.test(bsrc) && !/' A'|` A`/.test(bsrc.replace(/\|\| 'A'/, '')), 'the unit of the current comes from its metric');

  // ── The remaining solar metric ──
  const F = require(path.join(__dirname, '..', 'modules/forecastRemaining'));
  const now = new Date(); now.setHours(10, 15, 0, 0);
  const at = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const periods = [{ period_end: at(10, 0), period: 'PT30M', pv_estimate: 9 }, { period_end: at(10, 30), period: 'PT30M', pv_estimate: 2 }, { period_end: at(11, 0), period: 'PT30M', pv_estimate: 4 }, { period_end: at(12, 0), period: 'PT60M', pv_estimate: 3 }];
  // 10:30 period is half over (0.25 h of 0.5): 2 kW x 0.5 h x 0.5 = 0.5; 11:00: 4 x 0.5 = 2; 12:00: 3 x 1 = 3
  assert.strictEqual(F.remainingKwh(periods, now.getTime()), 5.5, 'the ended period is left out, the current one counts for what is left');
  assert.strictEqual(F.remainingKwh(periods.slice(0, 1), now.getTime()), null, 'nothing ahead: no value');
  assert.strictEqual(F.remainingKwh([{ period_end: 'bad', pv_estimate: 1 }, { period_end: at(11, 0), pv_estimate: null }], now.getTime()), null);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  assert.strictEqual(F.remainingKwh([{ period_end: tomorrow.toISOString(), period: 'PT30M', pv_estimate: 5 }], now.getTime()), null, 'only today');
  assert.strictEqual(F.remainingKwh(undefined), null);
  F.resetForecastRemaining();
  assert.strictEqual(F.publishForecastRemaining({ hourly: periods }, now.getTime()), 5.5, 'published (a failing metric store never breaks it)');
  assert.strictEqual(F.publishForecastRemaining({ hourly: periods }, now.getTime() + 1000), null, 'at most once a minute');
  assert.strictEqual(F.METRIC, 'forecast_solar_remaining');
  assert.ok(/publishForecastRemaining\(result\)/.test(read('modules/solar.js')) && /publishForecastRemaining\(cached\.data\)/.test(read('modules/solar.js')), 'published on a fresh forecast and on a cached one');

  // ── Wiring ──
  const idx = read('public/js/components/index.js');
  for (const [type, fn] of [['ring-gauge', 'buildRingGauge'], ['battery-card', 'buildBatteryCard'], ['status-list', 'buildStatusList']]) {
    assert.ok(new RegExp(`'${type}': ${fn}`).test(idx), type + ' registered');
  }
  const upd = read('public/js/cards-update.js');
  for (const [type, fn] of [['ring-gauge', 'updateRingGauge'], ['battery-card', 'updateBatteryCard'], ['status-list', 'updateStatusList']]) {
    assert.ok(new RegExp(`blockTypes\\.has\\('${type}'\\)\\) ${fn}\\(state\\)`).test(upd), type + ' refreshed with the data');
  }
  const cat = read('public/js/editor-catalog.js');
  assert.ok(/'ring-gauge':\s+\{ group: 'gauges', name: 'Ring gauge'/.test(cat) && /'battery-card':\s+\{ group: 'gauges', name: 'Battery'/.test(cat) && /'status-list':\s+\{ group: 'values', name: 'Status list'/.test(cat), 'in the library');
  const ed = read('public/js/editor.js');
  for (const fnName of ['buildRingGaugeForm', 'buildBatteryCardForm', 'buildStatusListForm']) assert.ok(ed.includes('function ' + fnName), fnName);
  for (const id of ['modal-rg-title', 'modal-rg-icon', 'modal-rg-tracks', 'modal-bc-soc', 'modal-bc-current', 'modal-bc-showcurrent', 'modal-bc-currentmax', 'modal-bc-low', 'modal-bc-warn', 'modal-bc-fill', 'modal-sl-title', 'modal-sl-count', 'modal-sl-value', 'modal-sl-onc', 'modal-sl-counttext', 'modal-sl-ontext', 'modal-sl-offtext']) assert.ok(ed.includes(id), id);
  for (const type of ['ring-gauge', 'battery-card', 'status-list']) assert.ok(new RegExp(`case '${type}': \\{`).test(ed), type + ' has a save case');
  const save = ed.slice(ed.indexOf("case 'ring-gauge': {"), ed.indexOf("case 'power-flow': {"));
  assert.ok(!/\brenderRowList\b|\breadRowList\b|\bescHtml\b|\bmetricSelect\b/.test(save), 'the save cases use only the document, as the editor tests that extract readSettingsForm need');
  const sc = read('private/js/showcase-layout.js'), so2 = read('private/js/showcase.js');
  for (const type of ['ring-gauge', 'battery-card', 'status-list']) { assert.ok(sc.includes(`type: '${type}'`), type + ' in the showcase'); assert.ok(so2.includes(`'${type}': [`), type + ' options in the showcase'); }
  const css = read('public/cards.css');
  assert.ok(/\.ring-gauge-card\s*\{[^}]*container-type:\s*size/.test(css) && /\.rg-dial\s*\{[^}]*container-type:\s*size/.test(css), 'the ring gauge and its dial are size containers');
  assert.ok(/\.battery-card\s*\{[^}]*container-name:\s*bc-card/.test(css) && /@container bc-card/.test(css), 'the battery card queries its own size');
  assert.ok(/\.status-list-card\s*\{[^}]*container-type:\s*size/.test(css) && /--sl-font:[^;]*cqh[^;]*cqw/.test(css), 'the status list text follows the row height and the width');
  assert.ok(/\.rg-n1 \.rg-dial \{ --rg-fs: 15cqmin/.test(css) && /\.rg-n3 \.rg-dial \{ --rg-fs: 7\.9cqmin/.test(css), 'the centre text is sized to fit inside the innermost ring');
  assert.ok(/@media \(max-width: 768px\)[^}]*\.ring-gauge-card/.test(css) && /\.battery-card \{ min-height/.test(css) && /\.status-list-card \{ min-height/.test(css), 'each keeps a height where phones stack the blocks');
  const sd = read('private/js/showcase-data.js');
  for (const m of ['battery_current', 'ambient_temperature', 'device_boiler']) assert.ok(sd.includes(m), m + ' in the showcase data');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
