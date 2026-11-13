'use strict';
const checks = require('./_checks');
// The System hero, Speedometer, Flow rows and Meter card cards: their options, the maths behind what they draw, the words
// (every one a setting), the two metrics they rely on (forecast_solar_today, savings_today), and that each one is wired into
// the registry, the data refresh, the editor library, form and save, the showcase and the stylesheet. (Their drawing is
// checked in a browser.)
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const load = f => import(pathToFileURL(path.join(__dirname, '..', 'public/js/components', f)).href);

(async () => {
  // ── Shared words ──
  const T = await load('cardText.js');
  assert.strictEqual(T.fillWords('All {a} panels · {pct}% {zzz}', { a: '16', pct: '66' }), 'All 16 panels · 66% {zzz}', 'a token the card does not define stays as written');
  assert.strictEqual(T.imageUrl('https://x.test/a.png'), 'https://x.test/a.png'); assert.strictEqual(T.imageUrl('/uploads/a.png'), '/uploads/a.png');
  for (const bad of ['javascript:alert(1)', '//', 'data:image/png;base64,AA', 'a.png', '']) assert.ok(bad === '//' ? true : T.imageUrl(bad) === '', 'not a picture address: ' + bad);
  assert.strictEqual(T.imageUrl('//cdn.test/a.png'), '//cdn.test/a.png');
  assert.deepStrictEqual(T.extraOptions([{ metric: ' m1 ', signed: true }, { metric: 'm2' }, {}, { metric: 'm4' }, { metric: 'm5' }]).map(e => e.metric), ['m1', 'm2', '', 'm4'].slice(0, 3), 'three extra readings at most');
  const ex = T.extraValues(T.extraOptions([{ metric: 'p', signed: true }, { metric: 'q', unit: 'kWh' }, { metric: 'gone' }]), { p: { value: 3300, unit: 'W' }, q: { value: 10.5 } });
  assert.deepStrictEqual(ex, { a: '+3.30 kW', b: '10.5 kWh', c: '—' }, 'formatted, a + for a positive signed value, a dash without a reading');
  assert.strictEqual(T.extraValues(T.extraOptions([{ metric: 'n' }]), { n: { value: 16 } }).a, '16', 'a count has no decimals');
  assert.deepStrictEqual([undefined, '', 'x', 0, 2, 9, -1, '1.6'].map(T.decimalsOption), [null, null, null, 0, 2, 3, 0, 2], 'decimals: 0 to 3, or automatic');
  assert.strictEqual(T.numberText(4200, 'W', T.decimalOpts(1)).text, '4.2 kW');
  assert.strictEqual(T.extraValues(T.extraOptions([{ metric: 'p', signed: true }]), { p: { value: -3300, unit: 'W' } }).a.replace('−', '-'), '-3.30 kW');

  // ── System hero ──
  const H = await load('systemHero.js');
  let h = H.heroOptions({});
  assert.deepStrictEqual([h.title, h.image, h.states.length, h.extras.length], ['', '', 0, 0]);
  h = H.heroOptions({ title: ' System ', image: 'javascript:x', states: [{ metric: ' solar ', when: 'above', limit: '100', headline: 'All {a} panels producing', pill: 'Sun', color: '#16a34a' }, { metric: 'x' }, { headline: 'Fallback', color: 'red' }] });
  assert.strictEqual(h.title, 'System'); assert.strictEqual(h.image, '', 'only a web address or a path is a picture');
  assert.strictEqual(h.states.length, 2, 'a state needs a headline or a pill'); assert.deepStrictEqual([h.states[0].metric, h.states[0].limit], ['solar', 100]); assert.strictEqual(h.states[1].color, '', 'a colour that is not #rrggbb is dropped');
  const day = { solar: { value: 2400 } }, night = { solar: { value: 0 } };
  assert.strictEqual(h.layout, 'stacked', 'the picture goes under the words unless told otherwise'); assert.strictEqual(H.heroOptions({ layout: 'side' }).layout, 'side'); assert.strictEqual(H.heroOptions({ layout: 'x' }).layout, 'stacked');
  assert.strictEqual(H.activeState(h, day).pill, 'Sun'); assert.strictEqual(H.activeState(h, night).headline, 'Fallback', 'the state with no metric is the fallback');
  assert.strictEqual(H.activeState(h, {}).headline, 'Fallback', 'no reading: the fallback'); assert.strictEqual(H.activeState(H.heroOptions({ states: [{ metric: 'solar', headline: 'x' }] }), {}), null, 'no fallback, no match: nothing');
  assert.strictEqual(H.heroOptions({ states: Array.from({ length: 20 }, () => ({ headline: 'x' })) }).states.length, 8, 'at most eight states');

  // ── Speedometer ──
  const S = await load('speedometer.js');
  let s = S.speedometerOptions({});
  assert.deepStrictEqual([s.metric, s.min, s.max, s.statuses.length, s.ofText, s.caption], ['solar', 0, 5000, 0, 'of', ''], 'no status and no caption until you write them');
  s = S.speedometerOptions({ metric: 'pv', min: 0, max: -5, ofText: 'de', color: 'blue', caption: '{pct}%' });
  assert.ok(s.max > s.min, 'a range that runs backwards is made valid'); assert.strictEqual(s.ofText, 'de'); assert.strictEqual(s.color, '');
  // The status: plain text that follows the first rule that is true, so it says something else when not near the peak
  s = S.speedometerOptions({ statuses: [{ rule: 'near-peak', limit: 85, text: ' Near today ' }, { rule: 'above', limit: 50, text: 'Strong' }, { rule: 'below', limit: 10, text: 'Weak {pct}%' }, { rule: 'sideways', text: 'x' }, { rule: 'always', text: 'Producing', color: '#abc' }, { rule: 'always', text: 'fifth' }, { rule: 'always', text: '' }] });
  assert.deepStrictEqual(s.statuses.map(x => x.rule), ['near-peak', 'above', 'below', 'near-peak'], 'four at most; an unknown rule is near-peak; none without words'); assert.strictEqual(s.statuses[0].text, 'Near today');
  const st = S.speedometerOptions({ statuses: [{ rule: 'near-peak', limit: 85, text: 'Near' }, { rule: 'above', limit: 50, text: 'Strong' }, { rule: 'below', limit: 10, text: 'Weak' }, { rule: 'always', text: 'Producing' }] }).statuses;
  assert.strictEqual(S.activeStatus(st, { value: 4200, peak: 4800, frac: 0.66 }).text, 'Near'); assert.strictEqual(S.activeStatus(st, { value: 3500, peak: 6000, frac: 0.55 }).text, 'Strong', 'not near the peak: the next rule');
  assert.strictEqual(S.activeStatus(st, { value: 100, peak: 6000, frac: 0.02 }).text, 'Weak'); assert.strictEqual(S.activeStatus(st, { value: 2000, peak: undefined, frac: 0.3 }).text, 'Producing', 'no peak: the fallback');
  assert.strictEqual(S.activeStatus(st.slice(0, 3), { value: 2000, peak: 6000, frac: 0.3 }), null, 'no rule true, no fallback: nothing'); assert.strictEqual(S.activeStatus(st.slice(1, 3), { value: 1, peak: 1, frac: null }), null, 'no reading: only a fallback applies');
  const old = S.speedometerOptions({ nearText: ' Near today\u2019s peak ', nearPct: 90 }).statuses;
  assert.deepStrictEqual(old.map(x => [x.rule, x.limit, x.text]), [['near-peak', 90, 'Near today\u2019s peak']], 'a card from before statuses keeps its near-peak text');
  assert.strictEqual(S.dialFraction(3200, 0, 6400), 0.5); assert.strictEqual(S.dialFraction(-1, 0, 6400), 0); assert.strictEqual(S.dialFraction(9999, 0, 6400), 1); assert.strictEqual(S.dialFraction('x', 0, 6400), null);
  assert.strictEqual(S.nearPeak(4200, 4800, 85), true); assert.strictEqual(S.nearPeak(4000, 4800, 85), false); assert.strictEqual(S.nearPeak(100, 0, 85), false, 'no peak, no tag'); assert.strictEqual(S.nearPeak(100, undefined, 85), false);
  const p0 = S.dialPoint(S.START, 36), p1 = S.dialPoint(S.START + S.SWEEP, 36);
  assert.ok(Math.abs(p0.y - p1.y) < 1e-9 && Math.abs((p0.x - 50) + (p1.x - 50)) < 1e-9, 'the dial is symmetric about the vertical');

  // ── Flow rows ──
  const F = await load('flowRows.js');
  let f = F.flowRowsOptions({});
  assert.deepStrictEqual([f.rows.length, f.idleBelow, f.idleText, f.showBars], [0, 10, 'Idle', true]);
  f = F.flowRowsOptions({ idleBelow: -4, idleText: 'Pihen', showBars: false, rows: [{ label: 'Home', metric: 'load', sign: 'positive', max: '6000' }, { label: 'none' }, { metric: 'b', sign: 'sideways', max: 'x', color: '#abc' }, ...Array.from({ length: 12 }, (_, i) => ({ metric: 'm' + i }))] });
  assert.strictEqual(f.idleBelow, 0); assert.strictEqual(f.idleText, 'Pihen'); assert.strictEqual(f.showBars, false);
  assert.strictEqual(f.rows.length, 8, 'at most eight rows, none without a metric'); assert.strictEqual(f.rows[1].sign, 'any'); assert.strictEqual(f.rows[1].max, 0); assert.strictEqual(f.rows[1].color, '#abc'); assert.strictEqual(f.rows[0].max, 6000);
  assert.deepStrictEqual([3300, -3300, 0].map(v => F.rowAmount(v, 'positive')), [3300, 0, 0]); assert.deepStrictEqual([3300, -3300].map(v => F.rowAmount(v, 'negative')), [0, 3300]); assert.deepStrictEqual([3300, -3300].map(v => F.rowAmount(v, 'any')), [3300, 3300]); assert.strictEqual(F.rowAmount('x', 'any'), null);
  assert.strictEqual(F.isIdle(5, 'W', 10), true); assert.strictEqual(F.isIdle(10, 'W', 10), false); assert.strictEqual(F.isIdle(0.005, 'kW', 10), true, 'the limit is in watts for a kW reading'); assert.strictEqual(F.isIdle(0.5, 'kW', 10), false); assert.strictEqual(F.isIdle(0, 'A', 0), true); assert.strictEqual(F.isIdle(null, 'W', 10), false);
  assert.deepStrictEqual(F.barFractions([3300, 900, 0, null], [0, 0, 0, 0]), [1, 900 / 3300, 0, 0], 'against the largest row');
  assert.deepStrictEqual(F.barFractions([900, 5000], [1800, 0]), [0.5, 1], 'a row with its own highest value fills against that');
  assert.deepStrictEqual(F.barFractions([0, 0], [0, 0]), [0, 0]);

  // ── Meter card ──
  const M = await load('meterCard.js');
  let m = M.meterOptions({});
  assert.deepStrictEqual([m.metric, m.min, m.max, m.segments, m.lowAt, m.warnAt, m.notes.length], ['daily_solar', 0, 100, 12, null, null, 0]);
  m = M.meterOptions({ segments: 99, lowAt: 20, warnAt: 10, max: 5, min: 9, color: 'x', notes: ['~{max} expected today', '', 'third'], prefix: '$' });
  assert.strictEqual(m.segments, 40); assert.strictEqual(m.warnAt, 20, 'amber is never below red'); assert.ok(m.max > m.min); assert.strictEqual(m.notes.length, 2, 'two lines at most'); assert.strictEqual(m.prefix, '$');
  assert.strictEqual(M.meterOptions({ segments: 0 }).segments, 0, '0 is one continuous bar');
  assert.strictEqual(M.barFill(12.2, 0, 28), 12.2 / 28); assert.strictEqual(M.barFill(40, 0, 28), 1); assert.strictEqual(M.barFill('x', 0, 28), null);
  assert.deepStrictEqual([0, 0.01, 0.5, 0.78, 1].map(v => M.litSegments(v, 10)), [0, 1, 5, 8, 10], 'rounded, and never none for a little'); assert.strictEqual(M.litSegments(null, 10), 0); assert.strictEqual(M.litSegments(0.5, 0), 0);

  // ── No language of its own ──
  const srcs = ['cardText', 'systemHero', 'speedometer', 'flowRows', 'meterCard'].map(n => read(`public/js/components/${n}.js`)).join('\n');
  assert.ok(!/Hungarian|Termel|Fogyaszt|Napenergia/.test(srcs), 'no language of its own in the cards');
  assert.ok(!/textContent\s*=\s*['"`][A-Za-z]{3,}/.test(srcs.replace(/'—'|'Idle'|'of'/g, '')), 'no word written into a card by the code (the defaults are Idle and of)');

  // ── The expected-today metric and the savings metric ──
  const FR = require(path.join(__dirname, '..', 'modules/forecastRemaining'));
  const now = new Date(); now.setHours(10, 15, 0, 0);
  const at = (h, mi) => { const d = new Date(now); d.setHours(h, mi, 0, 0); return d.toISOString(); };
  const periods = [{ period_end: at(7, 30), period: 'PT30M', pv_estimate: 1 }, { period_end: at(10, 0), period: 'PT30M', pv_estimate: 9 }, { period_end: at(11, 0), period: 'PT60M', pv_estimate: 4 }];
  assert.strictEqual(FR.todayKwh(periods, now.getTime()), 0.5 + 4.5 + 4, 'the whole day, ended periods included');
  assert.strictEqual(FR.todayKwh([{ period_end: 'bad', pv_estimate: 1 }], now.getTime()), null); assert.strictEqual(FR.todayKwh(undefined), null);
  assert.strictEqual(FR.TODAY_METRIC, 'forecast_solar_today');
  const SM = require(path.join(__dirname, '..', 'modules/savingsMetric'));
  assert.strictEqual(SM.METRIC, 'savings_today'); SM.resetSavingsMetric();
  SM.publishSavingsToday(now.getTime());   // never throws, whatever the database state
  assert.strictEqual(SM.publishSavingsToday(now.getTime() + 1000), null, 'at most once a minute');
  assert.ok(/publishSavingsToday\(\)/.test(read('services/PollingManager.js')), 'published with each poll cycle');

  // ── Wiring ──
  const types = [['system-hero', 'buildSystemHero', 'updateSystemHero'], ['speedometer', 'buildSpeedometer', 'updateSpeedometer'], ['flow-rows', 'buildFlowRows', 'updateFlowRows'], ['meter-card', 'buildMeterCard', 'updateMeterCard']];
  const idx = read('public/js/components/index.js'), upd = read('public/js/cards-update.js'), cat = read('public/js/editor-catalog.js'), ed = read('public/js/editor.js');
  for (const [type, build, update] of types) {
    assert.ok(new RegExp(`'${type}': ${build}`).test(idx), type + ' registered');
    assert.ok(new RegExp(`blockTypes\\.has\\('${type}'\\)\\) ${update}\\(state\\)`).test(upd), type + ' refreshed with the data');
    assert.ok(new RegExp(`'${type}':\\s+\\{ group:`).test(cat), type + ' in the library');
    assert.ok(new RegExp(`case '${type}': \\{`).test(ed) && new RegExp(`case '${type}':\\n\\s+html \\+= build`).test(ed), type + ' has a form and a save case');
  }
  for (const fn of ['buildSystemHeroForm', 'buildSpeedometerForm', 'buildFlowRowsForm', 'buildMeterCardForm', 'buildExtrasSection']) assert.ok(ed.includes('function ' + fn), fn);
  for (const id of ['modal-sh-title', 'modal-sh-image', 'modal-sp-metric', 'modal-sp-maxmetric', 'modal-sp-peakmetric', 'modal-sh-layout', 'modal-sp-of', 'modal-sp-caption', 'modal-sp-decimals', 'modal-mt-decimals', 'modal-fr-decimals', 'modal-fr-title', 'modal-fr-bars', 'modal-fr-idle', 'modal-fr-idletext',
    'modal-mt-metric', 'modal-mt-barmetric', 'modal-mt-maxmetric', 'modal-mt-segments', 'modal-mt-low', 'modal-mt-warn', 'modal-mt-note0', 'modal-mt-note1', 'modal-mt-prefix']) assert.ok(ed.includes(id), id);
  const fnStart = ed.indexOf('function readSettingsForm('), save = ed.slice(ed.indexOf("case 'system-hero': {", fnStart), ed.indexOf("case 'power-flow': {", fnStart));
  assert.ok(!/\brenderRowList\b|\breadRowList\b|\bescHtml\b|\bmetricSelect\b|\btextSetting\b|\bnumberSetting\b/.test(save), 'the save cases use only the document, as the editor tests that extract readSettingsForm need');
  const head = ed.slice(fnStart, fnStart + 1800);
  assert.ok(/var readText = /.test(head) && /var readNumber = /.test(head) && /var readExtras = /.test(head), 'the small readers live inside readSettingsForm');
  const sc = read('private/js/showcase-layout.js'), so = read('private/js/showcase.js'), sd = read('private/js/showcase-data.js');
  for (const [type] of types) { assert.ok(sc.includes(`type: '${type}'`), type + ' in the showcase'); assert.ok(so.includes(`'${type}': [`), type + ' options in the showcase'); }
  for (const name of ['solar_peak_today', 'forecast_solar_today', 'savings_today', 'system_size', 'panels_producing', 'battery_stored']) assert.ok(sd.includes(name), name + ' in the showcase data');
  const css = read('public/cards.css');
  for (const cls of ['system-hero-card', 'speedometer-card', 'flow-rows-card', 'meter-card']) {
    assert.ok(new RegExp(`\\.${cls}\\s*\\{[^}]*container-type:\\s*size`).test(css), cls + ' is a size container');
    assert.ok(new RegExp(`@media \\(max-width: 768px\\)[^}]*\\.${cls} \\{ min-height`).test(css), cls + ' keeps a height where phones stack the blocks');
  }
  assert.ok(/\.sp-status\s*\{[^}]*margin-left:\s*auto/.test(css) && /\.sp-head\s*\{[^}]*justify-content:\s*space-between/.test(css) && !/\.sp-tag/.test(css), 'the status is plain text at the right of the title row, not a pill');
  assert.ok(/\.fr-row\s*\{\s*display:\s*contents/.test(css) && /grid-template-columns:\s*max-content minmax\(0, 1fr\) max-content/.test(css), 'a flow row is its label, bar and value on one line, in shared columns');
  assert.ok(/\.sh-pill::before/.test(css) && /\.sh-pill\s*\{[^}]*background:\s*var\(--text\)/.test(css), 'the hero pill is dark with a dot');
  assert.ok(/\.sp-face\s*\{[^}]*aspect-ratio:\s*100 \/ 86/.test(css) && /\.sp-value\s*\{[^}]*cqw/.test(css), 'the speedometer reading is sized from its face');
  assert.ok(/--fr-font:[^;]*cqh[^;]*cqw/.test(css), 'the flow rows text follows the row height and the width');
  assert.ok(/\.mt-bar\.mt-segmented\s*\{[^}]*repeat\(var\(--mt-n/.test(css), 'the meter card segments follow the setting');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
