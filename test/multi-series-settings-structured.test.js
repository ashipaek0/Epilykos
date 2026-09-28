import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMultiSeriesSettings } from '../public/js/multiSeriesTimeseriesSettings.mjs';
import { normalizeBarGaugeSettings } from '../public/js/multiSeriesBarGaugeSettings.mjs';

test('timeseries normalization preserves unknown keys at config, axis, legend and series levels', () => {
  const source={future:{v:1},axis:{min:0,futureAxis:true},legend:{calculations:['mean'],futureLegend:2},series:[{binding:{metric:'power'},label:'Power',futureSeries:'x'}]};
  const normalized=normalizeMultiSeriesSettings(source);
  assert.deepEqual(normalized.future,source.future);
  assert.equal(normalized.axis.futureAxis,true);
  assert.equal(normalized.legend.futureLegend,2);
  assert.equal(normalized.series[0].futureSeries,'x');
});

test('bar gauge normalization preserves unknown block and series keys', () => {
  const normalized=normalizeBarGaugeSettings({future:1,series:[{binding:{metric:'power'},max:10,futureSeries:true}]});
  assert.equal(normalized.future,1);
  assert.equal(normalized.series[0].futureSeries,true);
});

test('settings forms are structured rather than raw JSON editors', async () => {
  const {readFile}=await import('node:fs/promises');
  const editor=await readFile(new URL('../public/js/editor.js',import.meta.url),'utf8');
  assert.doesNotMatch(editor,/Series JSON/);
  assert.doesNotMatch(editor,/Axis JSON|Legend JSON|Thresholds JSON/);
});

import { readMultiSeriesForm } from '../public/js/multiSeriesTimeseriesSettings.mjs';
import { readBarGaugeForm } from '../public/js/multiSeriesBarGaugeSettings.mjs';
import { mountMultiSeriesForm, serializeFields, editRows } from '../public/js/multiSeriesSettingsForm.mjs';
import { timeseriesFields, gaugeFields, thresholdFields } from '../public/js/multiSeriesSchema.mjs';
import { buildTimeseriesChartModel, calculateLegend } from '../public/js/multiSeriesTimeseries.mjs';
import { saveDashboardConfig, fetchDashboardConfig } from '../public/js/api.js';
import { applyTemplateImport } from '../public/js/dashboard-presets.mjs';
import template from '../public/js/dashboard-43-presets.mjs';

// Minimal DOM fixture: execute the production renderer and its actual listeners.
class Element {
  constructor(tag) { this.tagName=tag; this.children=[]; this.dataset={}; this.style={}; this.attributes={}; this.listeners={}; this.value=''; this.checked=false; }
  appendChild(child) { child.remove(); child.parent=this; this.children.push(child); return child; }
  replaceChildren() { for (const child of [...this.children]) child.remove(); }
  remove() { if(this.parent) { this.parent.children.splice(this.parent.children.indexOf(this),1); this.parent=null; } }
  insertBefore(child, before) { child.remove(); child.parent=this; this.children.splice(this.children.indexOf(before),0,child); }
  get previousElementSibling() { return this.parent?.children[this.parent.children.indexOf(this)-1]; }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this)+1]; }
  setAttribute(k,v) { this.attributes[k]=v; }
  addEventListener(k,fn) { this.listeners[k]=fn; }
  click() { this.listeners.click?.(); }
}
const document={createElement:tag=>new Element(tag)};
const all=root=>[root,...root.children.flatMap(all)];
const control=(root,key)=>all(root).find(e=>e.dataset.msField===key);
const action=(root,name)=>all(root).find(e=>e.tagName==='button' && e.textContent===name).click();
function mount(config={},gauge=false) { const host=new Element('div'); mountMultiSeriesForm(document,host,config,gauge); return host; }
function save(host,gauge=false) { const value=host.readSettings(); return (gauge?readBarGaugeForm:readMultiSeriesForm)(key=>value[key],value); }
const rows=host=>all(host).filter(e=>e.dataset.msRow==='Series');

test('pure row operations preserve order, nested metadata and isolate source objects',()=>{
  const source=[{id:'a',future:{x:1}},{id:'b'},{id:'c'}];
  const added=editRows(source,'add',0,{id:'d'});
  const moved=editRows(added,'up',3);
  assert.deepEqual(moved.map(r=>r.id),['a','b','d','c']);
  assert.deepEqual(editRows(moved,'down',0).map(r=>r.id),['b','a','d','c']);
  assert.deepEqual(editRows(moved,'remove',1).map(r=>r.id),['a','d','c']);
  moved[0].future.x=2; assert.equal(source[0].future.x,1);
});

test('DOM add/remove/move reads current edits and preserves unknown keys for both families',()=>{
  for(const gauge of [false,true]) {
    const host=mount({series:[{label:'A',binding:{metric:'a',future:7},max:10,future:{id:1}},{label:'B',binding:{metric:'b'},max:20}]},gauge);
    control(rows(host)[0],'label').value='Edited';
    action(rows(host)[0],'Move down Series row');
    assert.deepEqual(save(host,gauge).series.map(s=>s.label),['B','Edited']);
    action(rows(host)[1],'Move up Series row');
    assert.equal(save(host,gauge).series[0].binding.future,7);
    action(host,'Add Series row');
    control(rows(host)[2],'binding.metric').value='c';
    control(rows(host)[2],'label').value='C';
    assert.deepEqual(save(host,gauge).series.map(s=>s.binding.metric),['a','b','c']);
    action(rows(host)[1],'Remove Series row');
    assert.deepEqual(save(host,gauge).series.map(s=>s.binding.metric),['a','c']);
    for(const button of all(host).filter(e=>e.tagName==='button')) {
      assert.equal(button.style.minHeight,'44px'); assert.equal(button.style.minWidth,'44px'); assert.ok(button.attributes['aria-label']);
    }
  }
});

test('all typed series fields serialize and reach runtime models',()=>{
  const row=serializeFields({binding:{future:1},future:2},{label:'Solar','binding.metric':'pv',unit:'W',reducer:'last',scale:'2.5',decimals:'3',color:'#123456',axis:'y1'},timeseriesFields);
  const normalized=normalizeMultiSeriesSettings({series:[row]});
  assert.deepEqual(normalized.series[0],{binding:{future:1,metric:'pv'},future:2,label:'Solar',unit:'W',reducer:'last',scale:2.5,decimals:3,color:'#123456',axis:'y1'});
  const model=buildTimeseriesChartModel(normalized);
  assert.equal(model.datasets[0].yAxisID,'y1'); assert.equal(model.datasets[0].scale,2.5); assert.ok(model.scales.y1);
  const gauge=normalizeBarGaugeSettings({series:[serializeFields({future:1},{label:'PV','binding.metric':'pv',unit:'kWh',decimals:'2',min:'-1',max:'10',color:'red'},gaugeFields)]});
  assert.equal(gauge.series[0].min,-1); assert.equal(gauge.series[0].max,10); assert.equal(gauge.series[0].color,'red');
});

test('global, axis, legend and repeatable threshold controls roundtrip',()=>{
  const source={future:{a:1},axis:{future:2},legend:{future:3,calculations:['max','mean']},thresholds:[{value:2,color:'red',future:4,dash:[9,2]}]};
  const host=mount(source);
  for(const [key,value] of Object.entries({title:'Chart',lineWidth:'3',fillOpacity:'.6',windowMs:'30000',hours:'12',stack:'A',tension:'.5',range:'12h'})) control(host,key).value=value;
  control(host,'smooth').checked=false;
  control(host,'type').value='logarithmic'; control(host,'min').value='1'; control(host,'max').value='100'; control(host,'centerZero').checked=true;
  control(host,'position').value='right'; // Axis position
  const legend=all(host).filter(e=>e.dataset.msField==='position')[1]; legend.value='right';
  all(host).find(e=>e.dataset.msCalculation==='min').checked=true;
  const threshold=all(host).find(e=>e.dataset.msRow==='Thresholds');
  control(threshold,'label').value='Limit'; control(threshold,'dash').value=''; control(threshold,'value').value='25';
  action(host,'Add Thresholds row');
  const result=save(host);
  assert.equal(result.title,'Chart'); assert.equal(result.lineWidth,3); assert.equal(result.fillOpacity,.6); assert.equal(result.windowMs,30000); assert.equal(result.hours,12); assert.equal(result.smooth,false); assert.equal(result.stack,'A'); assert.equal(result.tension,.5); assert.equal(result.range,'12h');
  assert.deepEqual(result.axis,{future:2,type:'logarithmic',position:'right',min:1,max:100,centerZero:true});
  assert.deepEqual(result.legend,{future:3,position:'right',calculations:['max','mean','min']});
  assert.deepEqual(result.thresholds[0],{value:25,color:'red',future:4,dash:[],label:'Limit'});
  assert.equal(result.thresholds.length,2); assert.deepEqual(save(mount(result)),result);
  result.future.a=7; assert.equal(source.future.a,1);
});

test('gauge globals inherit into series, including template null bounds and precision',()=>{
  const host=mount({unit:'kWh',precision:1,min:0,max:30,series:[{metric:'yield',max:null}]},true);
  control(host,'title').value='Yield'; control(host,'palette').value='energy';
  const result=save(host,true);
  assert.equal(result.title,'Yield'); assert.equal(result.palette,'energy'); assert.equal(result.series[0].max,30); assert.equal(result.series[0].unit,'kWh'); assert.equal(result.series[0].decimals,1); assert.equal(result.series[0].binding.metric,'yield');
  assert.deepEqual(save(mount(result,true),true),result);
});

test('invalid finite numbers, bounds, booleans, enums and named unbound rows reject without source mutation',()=>{
  for(const patch of [{lineWidth:Infinity},{hours:NaN},{windowMs:0},{fillOpacity:2},{smooth:'false'},{axis:{min:4,max:4}},{axis:{min:'bad'}},{axis:{type:'invalid'}},{legend:{position:'left'}},{series:[{decimals:101}]},{series:[{scale:Infinity}]},{series:[{reducer:'sum'}]},{thresholds:[{value:Infinity,color:'red'}]},{thresholds:[{value:1,color:'red',dash:[NaN]}]}]) assert.throws(()=>normalizeMultiSeriesSettings(patch));
  for(const patch of [{decimals:NaN},{precision:-1},{palette:'unknown'},{min:5,max:5},{series:[{max:Infinity}]},{series:[{max:0}]}]) assert.throws(()=>normalizeBarGaugeSettings(patch));
  assert.throws(()=>serializeFields({}, {scale:'bad'},timeseriesFields));
  assert.throws(()=>serializeFields({}, {dash:'1,,2'},thresholdFields));
  for(const gauge of [false,true]) {
    const source={series:[{label:'Named',binding:{metric:'pv'},max:10}],future:{x:1}};
    const before=structuredClone(source); const host=mount(source,gauge);
    control(rows(host)[0],'binding.metric').value=' ';
    assert.throws(()=>save(host,gauge),/needs a metric/); assert.deepEqual(source,before);
    assert.deepEqual(save(mount({series:[]},gauge),gauge).series,[]);
  }
});

test('all seven canonical presets normalize, edit, reopen, save/reload and export/import in order',async()=>{
  const canonical=structuredClone(template);
  const selected=canonical.dashboards.flatMap(d=>d.layout).filter(b=>b.type.startsWith('multi-series-'));
  assert.equal(selected.filter(b=>b.type==='multi-series-timeseries').length,5);
  assert.equal(selected.filter(b=>b.type==='multi-series-bar-gauge').length,2);
  const ids=selected.map(b=>b.panelId);
  for(const block of selected) {
    const gauge=block.type==='multi-series-bar-gauge';
    block.config.future={block:block.panelId}; block.config.series.forEach((s,i)=>s.future={index:i});
    const normalized=(gauge?normalizeBarGaugeSettings:normalizeMultiSeriesSettings)(block.config);
    assert.deepEqual(save(mount(block.config,gauge),gauge),normalized);
    const host=mount(block.config,gauge); control(host,'title').value=block.title;
    rows(host).forEach((row,i)=>{control(row,'binding.metric').value=`metric_${i}`; control(row,'label').value=`Series ${i}`;});
    block.config=save(host,gauge);
    assert.deepEqual(save(mount(block.config,gauge),gauge),block.config);
    assert.deepEqual(block.config.series.map(s=>s.future.index),block.config.series.map((s,i)=>i));
  }
  const previous=globalThis.fetch; let persisted;
  globalThis.fetch=async(_url,options)=>{if(options?.method==='POST') {persisted=JSON.parse(options.body); return {ok:true,json:async()=>({success:true})};} return {ok:true,status:200,text:async()=>JSON.stringify(persisted)};};
  try {
    await saveDashboardConfig(canonical);
    const reloaded=await fetchDashboardConfig(); assert.deepEqual(reloaded,canonical);
    const exported=JSON.stringify(reloaded);
    const imported=applyTemplateImport({},JSON.parse(exported),'replace');
    assert.deepEqual(imported.dashboards,canonical.dashboards);
    const again=imported.dashboards.flatMap(d=>d.layout).filter(b=>b.type.startsWith('multi-series-'));
    assert.deepEqual(again.map(b=>b.panelId),ids);
    for(const b of again) assert.deepEqual(save(mount(b.config,b.type==='multi-series-bar-gauge'),b.type==='multi-series-bar-gauge'),b.config);
  } finally {globalThis.fetch=previous;}
  assert.deepEqual(calculateLegend([0,2],['last']),{last:2});
});

test('editor invalid-save path leaves block untouched, reports error, and never persists or closes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../public/js/editor.js',import.meta.url),'utf8');
  function extract(name) { const start=source.indexOf(`function ${name}(`); return source.slice(start,source.indexOf('\n}',start)+2); }
  for(const gauge of [false,true]) {
    const block={type:gauge?'multi-series-bar-gauge':'multi-series-timeseries',config:{title:'Original',series:[{label:'PV',binding:{metric:'pv'},max:10}]}};
    const before=structuredClone(block); const host=mount(block.config,gauge);
    control(rows(host)[0],'binding.metric').value='';
    const status={style:{},textContent:''};
    const doc={getElementById:id=>id==='settings-modal-status'?status:host};
    const read=new Function('document','readMultiSeriesForm','readBarGaugeForm',`${extract('readSettingsForm')}; return readSettingsForm;`)(doc,readMultiSeriesForm,readBarGaugeForm);
    let persisted=0,closed=0;
    const handler=new Function('document','currentEditingBlock','readSettingsForm','persistLayout','hideSettingsModal','refreshGridItem','markUnsaved',`async ${extract('handleSettingsSave')}; return handleSettingsSave;`)(doc,block,read,async()=>{persisted++;return true;},()=>closed++,()=>{},()=>{});
    await handler();
    assert.deepEqual(block,before); assert.equal(persisted,0); assert.equal(closed,0);
    assert.match(status.textContent,/needs a metric/); assert.equal(status.style.display,'block');
  }
});
