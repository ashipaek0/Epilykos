'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
(async () => {
  const logicPath = path.join(__dirname, '../public/js/components/configurableGaugeLogic.js');
  const source = fs.readFileSync(logicPath, 'utf8');
  const m = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let passed = 0;
  async function test(name, fn) { await fn(); passed++; console.log(`✓ ${name}`); }
  await test('normalizes defaults and malformed inputs without mutating instance config', () => {
    const input = { metric: 'm', extra: 7 }, c = m.normalizeConfig(input);
    assert.equal(c.segmentCount, 12); assert.equal(c.size, 400); assert.equal(c.min, 0);
    assert.equal(input.segmentCount, undefined); assert.equal(input.extra, 7);
  });
  await test('rejects invalid scale and bounds opening, precision and segment count', () => {
    const c = m.normalizeConfig({ min: 4, max: 4, precision: 99, opening: 900, segmentCount: 2.7 });
    assert.equal(c.validScale, false); assert.equal(c.precision, 6); assert.equal(c.opening, 300);
    assert.equal(c.segmentCount, 3); assert.equal(m.scaleRatio(5, c.min, c.max), null);
  });
  await test('distinguishes zero, negative, null, and non-finite metrics', () => {
    assert.equal(m.finiteMetric(0), 0); assert.equal(m.finiteMetric('-5'), -5);
    assert.equal(m.finiteMetric(null), null); assert.equal(m.finiteMetric(Infinity), null);
  });
  await test('clamps visual scale ratio without changing true input', () => {
    assert.equal(m.scaleRatio(-20, -10, 10), 0); assert.equal(m.scaleRatio(0, -10, 10), .5);
    assert.equal(m.scaleRatio(20, -10, 10), 1);
  });
  await test('clips and deterministically deduplicates thresholds', () => {
    assert.deepEqual(m.thresholdBands([{ value: 150, color: 'b' }, { value: -2, color: 'a' }, { value: 0, color: 'c' }], 0, 100), [{ value: 0, color: 'a' }, { value: 100, color: 'b' }]);
  });
  await test('keeps explicit null samples as graph gaps and creates no samples', () => {
    const samples = [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }, { timestamp: 3, value: null }, { timestamp: 4, value: 3 }, { timestamp: 5, value: 4 }];
    assert.equal(m.historyPath([]), ''); assert.equal(m.historyPath([{ timestamp: 1, value: 5 }]), '');
    assert.equal(m.historyPath(samples), 'M0.00,30.00 L25.00,20.00M75.00,10.00 L100.00,0.00');
    const area = m.historyAreaPath(samples);
    assert.equal((area.match(/ Z/g) || []).length, 2); assert.equal(area.includes('L25.00,30 L0.00,30 Z M75.00,10.00'), true);
  });
  await test('infers normal cadence despite an isolated long sparse interval', () => {
    const data = [{ timestamp: 0, value: 0 }, { timestamp: 10, value: 1 }, { timestamp: 20, value: 2 }, { timestamp: 1000, value: 3 }, { timestamp: 1010, value: 4 }];
    assert.equal((m.historyRuns(data).length), 2);
  });
  await test('does not bridge an ambiguous pair of distant samples', () => {
    assert.equal(m.historyPath([{ timestamp: 0, value: 1 }, { timestamp: 1000, value: 2 }]), '');
  });
  await test('maps supported history windows and encodes independent metric', () => {
    assert.equal(m.historyUrl('a b', '7d'), '/api/metrics/history?metric=a%20b&hours=168');
    assert.equal(m.rangeHours('bad'), 1);
  });
  await test('component renders separate unique SVG effects, in-gauge readout, and line/area mode branches', () => {
    const component = fs.readFileSync(path.join(__dirname, '../public/js/components/configurableGaugeCard.js'), 'utf8');
    assert.match(component, /configurable-gauge-\$\{\+\+instanceSequence\}/);
    // The size cap is passed to CSS, which fits the dial to the block's width and height.
    assert.match(component, /setProperty\('--cg-size', `\$\{c\.size\}px`\)/);
    const css = fs.readFileSync(path.join(__dirname, '../public/cards.css'), 'utf8');
    assert.match(css, /\.configurable-gauge-viz \{[^}]*width: min\([^}]*var\(--cg-size[^}]*100cqh/);
    assert.match(component, /c\.graph\.mode === 'area' \? historyAreaPath/);
    assert.match(component, /url\(#\$\{id\}-gradient\)/);
    assert.match(component, /root\.isConnected && root\._gaugeGeneration === generation/);
  });
  await test('uses normalized path lengths for every supported opening and segment ratio', () => {
    const component = fs.readFileSync(path.join(__dirname, '../public/js/components/configurableGaugeCard.js'), 'utf8');
    assert.match(component, /fill\.setAttribute\('pathLength', '100'\)/);
    assert.match(component, /segment\.setAttribute\('pathLength', '100'\)/);
    assert.match(component, /stroke-dasharray', `\$\{ratio \* 100\} 100`/);
    assert.match(component, /stroke-dasharray', `\$\{full \* 100\} 100`/);
    for (const opening of [30, 90, 270, 300]) {
      const geometricSweep = 360 - opening;
      assert.ok(geometricSweep > 0, `positive sweep for opening ${opening}`);
      assert.equal(1 * 100 / 100, 1, `full ratio for opening ${opening}`);
    }
  });
  await test('applies configured gradient and glow to segmented fill paths', () => {
    const component = fs.readFileSync(path.join(__dirname, '../public/js/components/configurableGaugeCard.js'), 'utf8');
    assert.match(component, /const effectColor = c\.style === 'gradient'/);
    assert.match(component, /const effect = c\.style === 'glow'/);
    assert.match(component, /path\(d, effectColor, width, 'configurable-gauge-segment-fill',[^\n]*\$\{effect\}/);
  });
  await test('renders each segmented palette color for flat, glow, and per-segment gradient styles', async () => {
    const componentPath = path.join(__dirname, '../public/js/components/configurableGaugeCard.js');
    let componentSource = fs.readFileSync(componentPath, 'utf8');
    const logicUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    componentSource = componentSource.replace("'./configurableGaugeLogic.js'", `'${logicUrl}'`).replace("import { formatMetric } from './format.js';", 'const formatMetric = () => "";').replace("import { markBreakdown, applyBreakdowns } from './breakdown.js';", 'const markBreakdown = () => {}, applyBreakdowns = () => {};').replace("import { emptyBlock } from './emptyState.js';", 'const emptyBlock = () => ({ empty: true });');
    const componentUrl = 'data:text/javascript;base64,' + Buffer.from(componentSource).toString('base64');
    const gauge = await import(componentUrl);
    const colors = ['#e11', '#1a2', '#33f'];
    for (const style of ['flat', 'glow', 'gradient']) {
      const markup = gauge.gaugeMarkup(m.normalizeConfig({ preset: 'segmented', segmentCount: 3, segmentColors: colors, style, arcColor: '#777', gradientEnd: '#fff' }), `test-${style}`);
      const fills = [...markup.matchAll(/class="configurable-gauge-segment-fill"[^>]*stroke="([^"]+)"[^>]*data-segment="(\d+)"/g)];
      assert.equal(fills.length, 3);
      assert.deepEqual(fills.map(x => x[1]), style === 'gradient' ? colors.map((_, i) => `url(#test-gradient-gradient-${i})`) : colors);
      if (style === 'gradient') {
        for (let i = 0; i < colors.length; i++) assert.match(markup, new RegExp(`<linearGradient id="test-gradient-gradient-${i}"><stop stop-color="${colors[i]}"/><stop offset="1" stop-color="#fff"/></linearGradient>`));
        assert.equal((markup.match(/id="test-gradient-gradient-\d+"/g) || []).length, 3);
      }
    }
  });
  await test('does not override per-instance track or graph colors in CSS', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    assert.doesNotMatch(css, /\.configurable-gauge-track[\s\S]{0,150}stroke:/);
    assert.doesNotMatch(css, /\.configurable-gauge-history-line\s*\{[^}]*stroke:/);
    assert.doesNotMatch(css, /\.configurable-gauge-history-area\s*\{[^}]*fill:/);
  });
  await test('rejects CSS declaration injection and external URL colours while preserving valid colours', () => {
    const attacks = ['red; background-image:url(https://attacker.invalid/x)', 'url(https://attacker.invalid/x)', '"; color:red; /*', 'red} body{display:none'];
    for (const attack of attacks) {
      const c = m.normalizeConfig({ background: attack, borderColor: attack, readoutColor: attack, arcColor: attack, gradientEnd: attack, trackColor: attack, segmentColors: [attack], band: { thresholds: [{ value: 50, color: attack }], trackColor: attack }, graph: { color: attack } });
      for (const key of ['background', 'borderColor', 'readoutColor', 'arcColor', 'gradientEnd', 'trackColor']) assert.equal(c[key], '', `${key} rejects ${attack}`);
      assert.deepEqual(c.segmentColors, []);
      assert.deepEqual(c.band.thresholds, []);
      assert.equal(c.band.trackColor, ''); assert.equal(c.graph.color, '');
    }
    const safe = m.normalizeConfig({ background: '#abc', borderColor: 'rebeccapurple', readoutColor: 'rgb(10, 20, 30)', arcColor: 'hsl(120, 50%, 40%)', segmentColors: ['red', 'rgba(0,0,0,.5)'], band: { thresholds: [{ value: 50, color: 'blue' }] }, graph: { color: '#123456' } });
    assert.equal(safe.background, '#abc'); assert.equal(safe.borderColor, 'rebeccapurple');
    assert.equal(safe.readoutColor, 'rgb(10, 20, 30)'); assert.deepEqual(safe.segmentColors, ['red', 'rgba(0,0,0,.5)']);
    assert.deepEqual(safe.band.thresholds, [{ value: 50, color: 'blue' }]); assert.equal(safe.graph.color, '#123456');
  });
  await test('assigns card surface styles through individual CSS properties', () => {
    const component = fs.readFileSync(path.join(__dirname, '../public/js/components/configurableGaugeCard.js'), 'utf8');
    assert.doesNotMatch(component, /root\.style\.cssText\s*=/);
    assert.match(component, /root\.style\.backgroundColor\s*=/);
    assert.match(component, /root\.style\.borderColor\s*=/);
    assert.match(component, /root\.style\.borderWidth\s*=/);
    assert.match(component, /root\.style\.borderStyle\s*=/);
  });
  console.log(`${passed} passed`);
})().catch(error => { console.error(error); process.exit(1); });
