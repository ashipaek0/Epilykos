'use strict';
// Exact-source editor regression tests: load production function bodies verbatim.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../public/js/editor.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing production function ' + name);
  let brace = source.indexOf('{', start), depth = 0, quote = '', escape = false;
  for (let i = brace; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}
const fields = {};
let thresholdRows = [];
const context = {
  document: {
    getElementById(id) { return fields[id] || null; },
    querySelectorAll(selector) { return selector === '#cg-threshold-rows [data-ui="row"]' ? thresholdRows : []; }
  },
  escHtml: x => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
  metricSelect: (_v, id) => '<select id="' + id + '"></select>',
  BAR_THRESHOLD_WARM: ['#a', '#b'], Array, Object, Number, String, Math, JSON
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function hexForPicker('), source.indexOf('\nfunction buildConfigurableGaugeForm(')) + '\n' + functionSource('buildConfigurableGaugeForm') + '\n' + functionSource('readSettingsForm'), context);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✓ ' + name); }
function setFields(values) {
  for (const [key, value] of Object.entries(values)) fields['cg-' + key] = { value: String(value), checked: Boolean(value) };
}
function thresholdRow(index, value, color) {
  return {
    getAttribute: name => name === 'data-threshold-index' ? String(index) : null,
    querySelector: selector => ({ value: selector === '.cg-threshold-value' ? String(value) : color })
  };
}
function validFields(overrides = {}) {
  const values = {
    metric: 'solar.power', title: 'Solar', unit: 'kW', min: '0', max: '850', precision: '2',
    showReadout: true, readoutColor: '#123456', readoutSize: '31', 'band-show': true,
    'band-thickness': '10', 'band-spacing': '4', 'band-trackColor': '#111111',
    preset: 'segmented', segmentCount: '16', segmentGap: '3', segmentColors: '#112233, #445566',
    style: 'gradient', arcColor: '#abcdef', gradientEnd: '#fedcba', arcThickness: '14',
    trackColor: '#222222', opening: '120', rotation: '15', size: '240',
    'graph-show': true, 'graph-metric': '', 'graph-window': '24h', 'graph-mode': 'area',
    'graph-thickness': '3', 'graph-color': '#334455', 'graph-opacity': '.35', 'graph-marker': true,
    background: '#010203', borderColor: '#040506', borderWidth: '2', radius: '18'
  };
  return Object.assign(values, overrides);
}
test('blank and whitespace bounds reject before touching saved config', () => {
  for (const raw of ['', '  ']) {
    fields['cg-min'] = { value: raw }; fields['cg-max'] = { value: '100' };
    const block = { type: 'configurable-gauge', config: { sentinel: { keep: true }, min: 4, max: 9 } };
    assert.match(context.readSettingsForm(block), /finite numbers/);
    assert.deepStrictEqual(block.config, { sentinel: { keep: true }, min: 4, max: 9 });
  }
});
test('non-finite and unordered bounds reject', () => {
  for (const [min, max] of [['NaN', '5'], ['Infinity', '9'], ['4', '4'], ['5', '4']]) {
    fields['cg-min'] = { value: min }; fields['cg-max'] = { value: max };
    assert.match(context.readSettingsForm({ type: 'configurable-gauge', config: {} }), /finite numbers/);
  }
});
test('form emits every documented field and optional colors as pickers with a theme default', () => {
  const html = context.buildConfigurableGaugeForm({ config: { opaqueRoot: { x: 1 }, band: {}, graph: {}, arcColor: '#abc' } });
  for (const id of ['cg-metric','cg-title','cg-unit','cg-min','cg-max','cg-precision','cg-showReadout','cg-readoutColor','cg-readoutSize','cg-band-show','cg-band-thickness','cg-band-spacing','cg-band-trackColor','cg-preset','cg-style','cg-segmentCount','cg-segmentGap','cg-segmentColors','cg-arcColor','cg-gradientEnd','cg-arcThickness','cg-trackColor','cg-opening','cg-rotation','cg-size','cg-graph-show','cg-graph-metric','cg-graph-window','cg-graph-mode','cg-graph-thickness','cg-graph-color','cg-graph-opacity','cg-graph-marker','cg-background','cg-borderColor','cg-borderWidth','cg-radius']) assert(html.includes('id="' + id + '"'), 'missing ' + id);
  for (const id of ['cg-readoutColor','cg-band-trackColor','cg-gradientEnd','cg-trackColor','cg-graph-color','cg-background','cg-borderColor']) {
    const control = html.match(new RegExp('<input type="hidden" id="' + id + '"[^>]*>'))[0];
    assert.match(control, /value=""/, id + ' stays unset (theme default) until a colour is picked');
  }
  assert.match(html, /<input type="hidden" id="cg-arcColor" value="#abc">/);
  assert.match(html, /<input type="color" class="color-opt-picker" value="#aabbcc"/, 'a set colour shows in its picker');
  assert(!/type="color"[^>]*id="cg-/.test(html), 'browser color inputs never carry the saved value (they coerce unset to black)');
});
test('valid save/reopen round-trips all configurable-gauge fields and isolates peer blocks', () => {
  const original = {
    type: 'configurable-gauge', config: {
      untouched: { keep: true }, metric: 'old', band: { thresholds: [{ value: 100, color: '#aaa', futureThresholdKey: 'keep' }], customBandKey: 9 },
      graph: { customGraphKey: 'keep' }, customRootKey: ['keep']
    }
  };
  const peer = { type: 'configurable-gauge', config: { marker: 'peer', graph: { marker: 'peer-graph' } } };
  const peerBefore = JSON.parse(JSON.stringify(peer));
  setFields(validFields());
  thresholdRows = [thresholdRow(0, '430', '#778899')];
  const result = context.readSettingsForm(original);
  assert(result == null);
  assert.deepStrictEqual(peer, peerBefore);
  const saved = JSON.parse(JSON.stringify(original.config));
  assert.deepStrictEqual(saved, {
    untouched: { keep: true }, metric: 'solar.power', enabled: true, transparent: false, bgColor: '', fontColor: '', fontSize: '',
    customRootKey: ['keep'], title: 'Solar', unit: 'kW', min: 0, max: 850,
    precision: 2, showReadout: true, readoutColor: '#123456', readoutSize: 31,
    band: { thresholds: [{ value: 430, color: '#778899', futureThresholdKey: 'keep' }], customBandKey: 9, show: true, thickness: 10, spacing: 4, trackColor: '#111111' },
    preset: 'segmented', segmentCount: 16, segmentGap: 3, segmentColors: ['#112233', '#445566'], style: 'gradient',
    arcColor: '#abcdef', gradientEnd: '#fedcba', arcThickness: 14, trackColor: '#222222', opening: 120, rotation: 15, size: 240,
    graph: { customGraphKey: 'keep', show: true, metric: '', window: '24h', mode: 'area', thickness: 3, color: '#334455', opacity: .35, marker: true },
    background: '#010203', borderColor: '#040506', borderWidth: 2, radius: 18
  });
  const reopened = context.buildConfigurableGaugeForm({ config: saved });
  for (const [id, value] of Object.entries({ 'cg-title': 'Solar', 'cg-unit': 'kW', 'cg-min': '0', 'cg-max': '850', 'cg-readoutColor': '#123456', 'cg-readoutSize': '31', 'cg-band-trackColor': '#111111', 'cg-segmentColors': '#112233, #445566', 'cg-arcColor': '#abcdef', 'cg-gradientEnd': '#fedcba', 'cg-trackColor': '#222222', 'cg-opening': '120', 'cg-rotation': '15', 'cg-size': '240', 'cg-graph-color': '#334455', 'cg-graph-opacity': '0.35', 'cg-background': '#010203', 'cg-borderColor': '#040506', 'cg-borderWidth': '2', 'cg-radius': '18' })) {
    assert.match(reopened, new RegExp('<input (?:type="hidden" )?id="' + id + '"[^>]*value="' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'), 'reopen missing ' + id);
  }
  assert.match(reopened, /value="430"/); assert.match(reopened, /value="#778899"/);
  // metricSelect is deliberately a stub here: this checks field persistence, not option rendering.
});
test('explicit nonempty custom colors and blank graph metric survive serialization', () => {
  setFields(validFields({ 'graph-metric': '' }));
  thresholdRows = [];
  const block = { type: 'configurable-gauge', config: { band: {}, graph: { metric: 'prior' } } };
  const result = context.readSettingsForm(block);
  assert(result == null);
  assert.strictEqual(block.config.readoutColor, '#123456');
  assert.strictEqual(block.config.band.trackColor, '#111111');
  assert.strictEqual(block.config.arcColor, '#abcdef');
  assert.strictEqual(block.config.gradientEnd, '#fedcba');
  assert.strictEqual(block.config.graph.color, '#334455');
  assert.strictEqual(block.config.graph.metric, '');
});
test('threshold removal is wired for pre-existing and newly added rows', () => {
  assert(source.includes("body.querySelectorAll('#cg-threshold-rows [data-ui=\"row\"]')"));
  assert.match(source, /aria-label', 'Remove threshold'/);
  assert.match(source, /row\.remove\(\)/);
});
console.log('configurable-gauge editor: ' + passed + ' passed, 0 failed');
