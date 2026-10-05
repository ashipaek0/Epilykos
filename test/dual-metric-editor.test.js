import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/editor.js', import.meta.url), 'utf8');
function extract(name, endMarker) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${name} end marker exists`);
  return source.slice(start, end);
}
function harness(values = {}, metrics = ['solar_kw', 'load_kw']) {
  const els = new Map(Object.entries(values).map(([id, value]) => [id, typeof value === 'object' ? value : {value: String(value)}]));
  const context = {availableMetrics: metrics, availableRestSources: [], WX_SOURCE_TYPES: [], WX_DISPLAY_FIELDS: [],
    escHtml: s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
    document: {getElementById: id => els.get(id) || null}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function hexForPicker('), source.indexOf('\nfunction buildConfigurableGaugeForm(')), context);
  vm.runInContext(extract('metricSelect', '\n// Text size choices'), context);
  vm.runInContext(extract('buildDualMetricForm', '\n/** Main entry:'), context);
  vm.runInContext(extract('buildSettingsForm', '\n/** Read all form values'), context);
  vm.runInContext(extract('readSettingsForm', '\n// ── Block content'), context);
  return {context, els};
}

test('Dual Metric form exposes exactly two fixed metric selectors and stores no third pane', () => {
  const {context} = harness();
  const html = context.buildSettingsForm({type:'dual-metric', config:{title:'Voltage', panes:{left:{metric:'solar_kw'},right:{metric:'load_kw'}}}});
  assert.equal((html.match(/id="dm-(left|right)-metric"/g) || []).length, 2);
  assert.match(html, /value="solar_kw" selected/); assert.match(html, /value="load_kw" selected/);
  assert.doesNotMatch(html, /third|add pane/i);
});

test('all Dual Metric fields round-trip repeatedly while unknown nested keys survive', () => {
  const values = {'dm-preset':'split-fill','dm-title':'Combined','dm-icon':'battery','dm-help':'Plain <help>',
    'dm-left-metric':'solar_kw','dm-left-label':'Left','dm-left-unit':'µV','dm-left-precision':'0','dm-left-value-color':'navy','dm-left-fill-color':'#112233','dm-left-label-color':'#223344','dm-left-unit-color':'','dm-left-value-font-size':'96','dm-left-label-font-size':'10','dm-left-unit-font-size':'32','dm-left-align':'left',
    'dm-right-metric':'load_kw','dm-right-label':'Right','dm-right-unit':'°C','dm-right-precision':'6','dm-right-value-color':'','dm-right-fill-color':'#334455','dm-right-label-color':'','dm-right-unit-color':'#eeeeee','dm-right-value-font-size':'12','dm-right-label-font-size':'32','dm-right-unit-font-size':'10','dm-right-align':'right',
    'dm-border-color':'','dm-border-width':'8','dm-radius':'0','dm-padding':'32','dm-pane-gap':'16','dm-divider-width':'0','dm-divider-color':'#abcdef','dm-header-color':'','dm-header-text-color':'#ffffff'};
  const original = {future:'keep',panes:{futurePane:{x:1},left:{futureLeft:true},right:{futureRight:true}},style:{futureStyle:'yes'}};
  const {context, els} = harness(values);
  const block = {type:'dual-metric',config:structuredClone(original)};
  assert.equal(context.readSettingsForm(block), null);
  const once = structuredClone(block.config);
  assert.equal(once.panes.left.unit, 'µV'); assert.equal(once.panes.right.unit, '°C');
  assert.equal(once.panes.left.precision, 0); assert.equal(once.panes.right.precision, 6);
  assert.equal(once.style.radius, 0); assert.equal(once.panes.left.labelFontSize, 10);
  assert.equal(once.future, 'keep'); assert.equal(once.panes.left.futureLeft, true); assert.equal(once.style.futureStyle, 'yes');
  const reopened = context.buildSettingsForm({type:'dual-metric',config:once});
  assert.match(reopened,/selected>Split-fill/); assert.match(reopened,/value="µV"/);
  assert.equal(context.readSettingsForm(block), null);
  assert.equal(JSON.stringify(block.config), JSON.stringify(once));
});

test('invalid required fields, enums, numbers, ranges, and colors reject without any block mutation', () => {
  const before = {preset:'neutral',title:'Saved',panes:{left:{metric:'solar_kw'},right:{metric:'load_kw'}},style:{borderWidth:1},keep:true};
  for (const [key,value] of Object.entries({'dm-title':'','dm-left-metric':'','dm-right-metric':'unknown','dm-preset':'other','dm-left-precision':'1.5','dm-right-value-font-size':'NaN','dm-left-label-font-size':'9','dm-pane-gap':'17','dm-border-width':'Infinity','dm-left-value-color':'red; background:url(javascript:1)'})) {
    const {context} = harness({[key]:value}); const block = {type:'dual-metric',config:structuredClone(before)};
    assert.match(context.readSettingsForm(block),/required|metric|preset|precision|font|range|color|finite/i, key);
    assert.deepEqual(block.config,before,key); assert.equal(block.enabled,undefined,key);
  }
});

test('unsafe authored text is escaped by the actual form builder and blank optional colors remain blank', () => {
  const {context} = harness();
  const html = context.buildSettingsForm({type:'dual-metric',config:{title:'<img src=x>',helpText:'<script>x</script>',panes:{left:{label:'<b>x</b>',valueColor:''},right:{}}}});
  assert.match(html,/&lt;img src=x&gt;/); assert.match(html,/&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html,/&lt;b&gt;x&lt;\/b&gt;/); assert.doesNotMatch(html,/<img|<script|<b>/);
});
