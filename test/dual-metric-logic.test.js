'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = path.join(__dirname, '..');
const utils = fs.readFileSync(path.join(project, 'public/js/utils.js'), 'utf8').replace(/export /g, '');
const formatSrc = fs.readFileSync(path.join(project, 'public/js/components/format.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
const formatBox = { Intl, Map }; vm.runInNewContext(`${utils}\n${formatSrc};globalThis.formatMetric=formatMetric;`, formatBox);
const logicSrc = fs.readFileSync(path.join(project, 'public/js/components/dualMetricLogic.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
const box = { formatMetric: formatBox.formatMetric }; vm.runInNewContext(`${logicSrc};globalThis.normalizeDualMetricConfig=normalizeDualMetricConfig;globalThis.resolveDualMetricPane=resolveDualMetricPane;globalThis.safeDualMetricColor=safeDualMetricColor;`, box);
const load = async file => file.endsWith('dualMetricLogic.js') ? box : formatBox;

test('dual metric normalizes only bounded fields, retaining unknown nested configuration', async () => {
  const { normalizeDualMetricConfig } = await load('public/js/components/dualMetricLogic.js');
  const c = normalizeDualMetricConfig({ preset: 'bad', title: 4, extra: 9, panes: { left: { metric: 'a', extra: 1, precision: 9, valueFontSize: 200, align: 'bad', fillColor: 'url(javascript:1)' }, right: { metric: 'b' } }, style: { radius: 90, padding: -5, extra: 2, borderColor: 'red; position:fixed' } });
  assert.equal(c.preset, 'neutral'); assert.equal(c.title, ''); assert.equal(c.extra, 9);
  assert.equal(c.panes.left.metric, 'a'); assert.equal(c.panes.left.extra, 1);
  assert.equal(c.panes.left.precision, 6); assert.equal(c.panes.left.valueFontSize, 96);
  assert.equal(c.panes.left.align, 'center'); assert.equal(c.panes.left.fillColor, '');
  assert.equal(c.panes.right.metric, 'b'); assert.equal(c.style.radius, 32);
  assert.equal(c.style.padding, 0); assert.equal(c.style.extra, 2); assert.equal(c.style.borderColor, '');
});

test('same metric bindings are independent, stale/missing differ from zero, and formatting uses shipped formatter', async () => {
  const logic = await load('public/js/components/dualMetricLogic.js');
  const format = await load('public/js/components/format.js');
  const c = logic.normalizeDualMetricConfig({ panes: { left: { metric: 'same', unit: 'W', precision: 2 }, right: { metric: 'same', unit: 'V', precision: 0 } } });
  const frame = { metrics: { same: { value: 1000, unit: 'W', quality: 'good' }, zero: { value: 0, unit: 'V', quality: 'good' }, stale: { value: 8, quality: 'stale' }, unavailable: { value: 8, quality: 'unavailable' }, bad: { value: NaN } } };
  const left = logic.resolveDualMetricPane(frame, c.panes.left);
  const right = logic.resolveDualMetricPane(frame, c.panes.right);
  assert.deepEqual(left.formatted, format.formatMetric(1000, 'W', { decimals: 2 }));
  assert.deepEqual(right.formatted, format.formatMetric(1000, 'V', { decimals: 0 }));
  assert.equal(left.formatted.value, '1.00'); assert.equal(left.formatted.unit, 'kW');
  assert.equal(logic.resolveDualMetricPane({ metrics: { zero: frame.metrics.zero } }, { metric: 'zero', precision: 0 }).formatted.value, '0');
  assert.equal(logic.resolveDualMetricPane(frame, { metric: 'stale' }).status, 'Stale');
  assert.equal(logic.resolveDualMetricPane(frame, { metric: 'unavailable' }).status, 'Unavailable');
  assert.equal(logic.resolveDualMetricPane(frame, { metric: 'missing' }).status, 'Missing');
  assert.equal(logic.resolveDualMetricPane(frame, { metric: 'bad' }).status, 'Missing');
  const negativeZero = logic.resolveDualMetricPane({ metrics: { n: { value: -0.0001, unit: 'V' } } }, { metric: 'n', unit: 'V', precision: 2 });
  assert.equal(negativeZero.formatted.value, '0.00');
});
