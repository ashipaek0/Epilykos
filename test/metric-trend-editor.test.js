import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/editor.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const marker = name === 'buildSettingsForm' ? '\n/** Read all form values' : name === 'readSettingsForm' ? '\n// ── Block content' : null;
  if (marker) return source.slice(start, source.indexOf(marker, start));
  const open = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}
function editorHarness(values, metrics = ['solar_kw', 'load_kw']) {
  const els = new Map(Object.entries(values || {}).map(([id, value]) => [id, typeof value === 'object' ? value : {value: String(value)}]));
  const context = { availableMetrics: metrics, availableRestSources: ['roof'], WX_SOURCE_TYPES: [], WX_DISPLAY_FIELDS: [], escHtml: s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
    document: { getElementById: id => els.get(id) || null } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function hexForPicker('), source.indexOf('\nfunction buildConfigurableGaugeForm(')), context);
  vm.runInContext(extract('metricSelect'), context);
  vm.runInContext(extract('buildMetricTrendForm'), context);
  vm.runInContext(extract('buildSettingsForm'), context);
  vm.runInContext(extract('readSettingsForm'), context);
  return { context, els };
}

test('metric trend form builds both presets and proper metric/forecast selectors safely', () => {
  const {context} = editorHarness();
  const block = {type:'metric-trend', config:{preset:'filled-body',title:'<img src=x>',icon:'sun',value:{source:'metric',metric:'solar_kw'},graph:{enabled:true,source:'metric-history',metric:'load_kw',window:'6h'},style:{headerColor:''}}};
  const html = context.buildSettingsForm(block);
  assert.match(html, /subtle-area/); assert.match(html, /filled-body/);
  assert.match(html, /solar_kw/); assert.match(html, /load_kw/);
  assert.match(html, /&lt;img src=x&gt;/); assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /today-remaining/); assert.match(html, /tomorrow-total/);
  assert.doesNotMatch(html, /threshold/i);
});

test('metric trend form values round-trip all approved fields while retaining unknown nested config', () => {
  const values = {
    'mt-preset':'filled-body','mt-title':'PV output','mt-icon':'sun','mt-value-source':'solar-forecast','mt-value-metric':'','mt-forecast-value':'today-remaining','mt-value-unit':'kWh','mt-value-source-select':'rest:roof','mt-value-rest-map':'{"pv_estimate":"estimate"}',
    'mt-graph-enabled':{checked:true},'mt-graph-source':'solar-forecast','mt-graph-metric':'','mt-graph-window':'7d','mt-graph-period':'tomorrow','mt-graph-source-select':'open-meteo','mt-graph-rest-map':'{"pv_estimate":"estimate"}', 'mt-graph-line-style':'line','mt-graph-line-width':'3','mt-graph-marker':{checked:true},'mt-graph-scale':'manual','mt-graph-min':'-5','mt-graph-max':'99',
    'mt-precision':'3','mt-compact':{checked:true},'mt-value-font-size':'42','mt-unit-font-size':'17','mt-align':'left',
    'mt-header-color':'','mt-header-text-color':'#eee','mt-body-fill':'#111','mt-body-fill-end':'#222','mt-gradient-angle':'45','mt-value-color':'#fff','mt-unit-color':'#ddd','mt-graph-line-color':'#abc','mt-graph-fill-color':'#def','mt-graph-fill-opacity':'0.4','mt-border-color':'','mt-border-width':'2','mt-radius':'8','mt-padding':'12'
  };
  const {context} = editorHarness(values);
  const original = {untouched:'yes',value:{mystery:{a:1}},graph:{futureFlag:true},display:{futureDisplay:'keep'},style:{futureStyle:'keep'}};
  const block = {type:'metric-trend',config:original};
  assert.equal(context.readSettingsForm(block),null);
  const saved = JSON.parse(JSON.stringify(block.config));
  assert.equal(saved.value.forecastValue,'today-remaining'); assert.equal(saved.value.forecastSource,'rest:roof');
  assert.equal(saved.graph.forecastPeriod,'tomorrow'); assert.equal(saved.graph.metric,''); assert.equal(saved.graph.max,99);
  assert.equal(saved.display.valueFontSize,42); assert.equal(saved.style.gradientAngle,45);
  assert.deepEqual(saved.graph.futureFlag,true); assert.deepEqual(saved.style.futureStyle,'keep'); assert.deepEqual(saved.display.futureDisplay,'keep');
  const reopened = editorHarness({}, ['solar_kw','load_kw']).context.buildSettingsForm({type:'metric-trend',config:saved});
  assert.match(reopened,/selected>Filled body/); assert.match(reopened,/today-remaining/);
});

test('metric trend invalid numeric input returns an error without mutating block or closing', () => {
  const {context} = editorHarness({'mt-graph-scale':'manual','mt-graph-min':'8','mt-graph-max':'2'});
  const before = {preset:'subtle-area',value:{source:'metric',metric:'solar_kw'},keep:true};
  const block = {type:'metric-trend',config:structuredClone(before)};
  assert.match(context.readSettingsForm(block),/minimum.*maximum|finite/i);
  assert.deepEqual(block.config,before);
});
