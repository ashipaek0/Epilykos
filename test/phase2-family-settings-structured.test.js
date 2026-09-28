import assert from 'node:assert/strict';
import { applyPhase2FormValues, normalizePhase2FamilyConfig, phase2FamilyFields } from '../public/js/phase2-family-settings.mjs';
for (const type of ['stat-metric','segmented-gauge','static-text','string-state']) assert.ok(phase2FamilyFields(type).length, `${type} exposes fields`);
assert.deepEqual(normalizePhase2FamilyConfig('static-text',{content:'Hi',future:{a:1}}),{content:'Hi',future:{a:1}});
assert.deepEqual(normalizePhase2FamilyConfig('stat-metric',{binding:{metric:''},label:'',future:{a:1}}).future,{a:1});
assert.throws(()=>applyPhase2FormValues('segmented-gauge',{}, {min:'10',max:'10'}),/less than/);
assert.throws(()=>applyPhase2FormValues('string-state',{}, {mappings:[{value:'ON',label:'On'},{value:'on',label:'Enabled'}]}),/case-insensitive/);
const unknown={nested:{x:[1,2]}};
const text=applyPhase2FormValues('static-text',{content:'old',unknown},{content:'new'});
assert.deepEqual(text.unknown,unknown);
const mapping=applyPhase2FormValues('string-state',{unknown},{mappings:[{value:'on',label:'On',color:'green'}]});
assert.deepEqual(mapping.unknown,unknown);
assert.deepEqual(mapping.mappings,[{value:'on',label:'On',color:'green'}]);

// Exercise the actual editor functions with a small DOM fixture, without an app runtime.
const { default: fs } = await import('node:fs');
const { default: vm } = await import('node:vm');
const { periodBindingWarning } = await import('../public/js/periodStat.mjs');
const source = fs.readFileSync(new URL('../public/js/editor.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.value = ''; }
  appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  insertBefore(child, sibling) { child.remove(); this.children.splice(this.children.indexOf(sibling), 0, child); child.parent = this; }
  get previousElementSibling() { return this.parent.children[this.parent.children.indexOf(this) - 1]; }
  get nextElementSibling() { return this.parent.children[this.parent.children.indexOf(this) + 1]; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  querySelectorAll(selector) { return this.children.flatMap(child => [ ...(selector === '[data-p2-field]' ? child.dataset.p2Field ? [child] : [] : child.className === selector.slice(1) ? [child] : []), ...child.querySelectorAll(selector)]); }
}
let elements = {};
const context = vm.createContext({ normalizePhase2FamilyConfig, applyPhase2FormValues, periodBindingWarning, escHtml: value => String(value).replaceAll('<','&lt;'), document: { getElementById: id => elements[id], createElement: tag => new Element(tag) } });
function loadFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}', start) + 2;
  vm.runInContext(source.slice(start, end), context);
}
for (const name of ['buildPhase2FamilyForm','renderPhase2Rows','readSettingsForm']) loadFunction(name);
function input(id, value) { const element = new Element('input'); element.value = value; elements['modal-p2-' + id] = element; return element; }
for (const [type, kind, rows] of [
  ['stat-metric','threshold',[{value:2,color:'red',label:'A',future:1},{value:1,color:'green',label:'B'}]],
  ['segmented-gauge','threshold',[{value:10,color:'amber',label:''},{value:20,color:'green',label:''}]],
  ['string-state','mapping',[{value:'on',label:'Enabled',color:'green'},{value:'off',label:'Disabled',color:'red'}]]
]) {
  elements = {};
  const container = elements['modal-p2-' + kind + '-rows'] = new Element();
  const add = elements['modal-p2-' + kind + '-add'] = new Element('button');
  const key = kind === 'threshold' ? 'thresholds' : 'mappings';
  const block = {type,config:{[key]:rows,unknown:{keep:true},binding:{metric:'old',future:true}}};
  context.renderPhase2Rows(block);
  assert.equal(container.children.length, 2);
  const first = container.children[0];
  const buttons = first.children.filter(el => el.tag === 'button');
  for (const button of buttons) { assert.equal(button.type,'button'); assert.ok(button['aria-label']); assert.equal(button.style.minHeight,'44px'); }
  buttons[1].listeners.click();
  assert.equal(container.children[1],first);
  buttons[0].listeners.click();
  assert.equal(container.children[0],first);
  if (type !== 'segmented-gauge') buttons[1].listeners.click();
  add.listeners.click(); // A completely blank added row is ignored on save.
  input('Metric','new'); input('Label','New label'); input('Unit','W');
  input('fallback-enabled','').checked = true; elements['modal-p2-fallback-enabled'].type = 'checkbox';
  input('fallback-value','0'); input('fallback-label','Missing');
  assert.equal(context.readSettingsForm(block),'');
  assert.deepEqual(block.config[key], type === 'segmented-gauge' ? rows : [...rows].reverse());
  assert.equal(block.config.binding.metric,'new'); assert.equal(block.config.binding.future,true);
  assert.equal(block.config.label,'New label'); assert.deepEqual(block.config.unknown,{keep:true});
  if (kind === 'threshold') { assert.equal(block.config.unit,'W'); assert.equal(block.config.fallback.value,0); }
  assert.deepEqual(normalizePhase2FamilyConfig(type, block.config),block.config);
  for (const row of [...container.children]) row.children.find(el => el.textContent === 'Remove').listeners.click();
  assert.equal(context.readSettingsForm(block),''); assert.deepEqual(block.config[key],[]);
}
elements = {};
input('Content','Edited');
const textBlock = {type:'static-text',config:{content:'Before',unknown}};
assert.equal(context.readSettingsForm(textBlock),''); assert.equal(textBlock.config.content,'Edited'); assert.deepEqual(textBlock.config.unknown,unknown);
assert.deepEqual(normalizePhase2FamilyConfig('static-text',textBlock.config),textBlock.config);

const periodBlock = {type:'stat-metric', config:{reducer:'period-sum', label:'Load Energy This Year', historyMetric:'daily_solar',formulaParams:{future:7},unknown}};
const before = JSON.stringify(periodBlock);
const html = context.buildPhase2FamilyForm(periodBlock);
assert.match(html, /<p id="p2-binding-warning">[^<]+<\/p>/);
assert.match(source, /periodBindingWarning\(c\.label,c\.historyMetric\)/);
assert.equal(JSON.stringify(periodBlock),before, 'warning rendering never mutates binding');
elements = {};
input('reducer','period-sum'); input('installDate','2020-01-02');
input('formulaParams-monthlyRate','225'); input('formulaParams-generatorCost','500'); input('formulaParams-generatorCapacity','12.5');
assert.equal(context.readSettingsForm(periodBlock),'');
assert.deepEqual(periodBlock.config.formulaParams,{future:7,monthlyRate:225,generatorCost:500,generatorCapacity:12.5});
assert.equal(periodBlock.config.installDate,'2020-01-02'); assert.equal(periodBlock.config.historyMetric,'daily_solar');
assert.deepEqual(normalizePhase2FamilyConfig('stat-metric',periodBlock.config),periodBlock.config);
assert.ok(phase2FamilyFields('stat-metric').includes('installDate'));
for (const result of [applyPhase2FormValues('stat-metric',periodBlock.config,{reducer:'lastNotNull'}),normalizePhase2FamilyConfig('stat-metric',{...periodBlock.config,reducer:'lastNotNull'})]) {
  for (const key of ['period','historyMetric','formula','formulaParams','currency','installDate']) assert.equal(key in result,false);
  assert.deepEqual(result.unknown,unknown);
}
for (const type of ['stat-metric','segmented-gauge']) {
  for (const value of ['',null,'nope',Infinity]) assert.throws(() => applyPhase2FormValues(type,{}, {thresholds:[{value}]}),/finite/);
  assert.throws(() => applyPhase2FormValues(type,{}, {min:10,max:0}),/less than/);
}
assert.throws(() => applyPhase2FormValues('segmented-gauge',{}, {thresholds:[{value:20},{value:10}]}),/ordered/);
assert.throws(() => applyPhase2FormValues('string-state',{}, {mappings:[{value:' ON ',label:'A'},{value:'on',label:'B'}]}),/unique/);
assert.throws(() => applyPhase2FormValues('stat-metric',{}, {reducer:'period-sum',formulaParams:{monthlyRate:'invalid'}}),/numeric/);

console.log('phase2-family-settings-structured.test.js: passed');
