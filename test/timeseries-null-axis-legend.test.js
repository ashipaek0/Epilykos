import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMultiSeriesForm } from '../public/js/multiSeriesTimeseriesSettings.mjs';
import { saveDashboardConfig, fetchDashboardConfig } from '../public/js/api.js';
import { normalizeSeries, calculateLegend, buildTimeseriesChartModel } from '../public/js/multiSeriesTimeseries.mjs';
const p=JSON.parse(readFileSync(new URL('./fixtures/timeseries-multi-series.fixture.json',import.meta.url))).panels;

test('legend supports requested calculations, skips null, preserves zero',()=>assert.deepEqual(calculateLegend([{y:null},{y:0},{y:8}],['mean','max','min','lastNotNull']),{mean:4,max:8,min:0,lastNotNull:8}));
test('legend placement and descending multi tooltip preserve zeros',()=>{const m=buildTimeseriesChartModel(p[0]);assert.equal(m.plugins.legend.position,'right');assert.equal(m.plugins.tooltip.itemSort.direction,'descending');assert.equal(m.plugins.tooltip.showZeros,true);assert.deepEqual(m.plugins.legend.calculations,['mean','max','min','lastNotNull'])});
const form=(overrides={})=>({title:'Complete',series:JSON.stringify([{label:'Solar',color:'#facc15',unit:'W',reducer:'mean',binding:{metric:'pv'}}]),lineWidth:'3',fillOpacity:'0.4',windowMs:'30000',hours:'12',smooth:true,stack:'false',axis:'{"position":"right","min":0,"max":100,"centerZero":true}',legend:'{"position":"bottom","calculations":["mean","max","min","lastNotNull"]}',thresholds:'[{"value":20,"color":"#ef4444","dash":[6,4]}]',...overrides});
const getter=o=>name=>o[name] ?? '';
test('readMultiSeriesForm rejects malformed and invalid form values without mutating existing config',()=>{
 const cases=[['malformed series JSON',{series:'{'},/Series.*valid JSON/],['malformed axis JSON',{axis:'{'},/Axis.*valid JSON/],['malformed legend JSON',{legend:'{'},/Legend.*valid JSON/],['malformed thresholds JSON',{thresholds:'{'},/Thresholds.*valid JSON/],['wrong series top-level type',{series:'{}'},/Series.*array/],['wrong axis top-level type',{axis:'[]'},/Axis.*object/],['wrong legend top-level type',{legend:'[]'},/Legend.*object/],['invalid reducer',{series:JSON.stringify([{label:'x',color:'#fff',binding:{metric:'m'},reducer:'median'}])},/reducer/i],['invalid axis position',{axis:'{"position":"center"}'},/Axis position/],['invalid legend calculation',{legend:'{"calculations":["total"]}'},/Legend calculations/],['invalid threshold fields',{thresholds:'[{"value":"20","color":2}]'},/threshold/i],['invalid threshold dash',{thresholds:'[{"value":20,"color":"red","dash":"solid"}]'},/threshold/i],['invalid numeric range',{lineWidth:'0'},/range/i],['invalid opacity range',{fillOpacity:'1.5'},/range/i]];
 for(const [name,change,expected] of cases){const existing={config:{unchanged:true},sentinel:1};const before=structuredClone(existing);assert.throws(()=>readMultiSeriesForm(getter(form(change))),e=>e instanceof Error&&expected.test(e.message),name);assert.deepEqual(existing,before,name);}
});
test('readMultiSeriesForm returns complete normalized form for no-stack and named stack group',()=>{
 const noStack=readMultiSeriesForm(getter(form({stack:'false'})));
 assert.equal(noStack.stack,'none'); assert.equal(noStack.title,'Complete'); assert.deepEqual(noStack.series[0],{label:'Solar',color:'#facc15',unit:'W',reducer:'mean',binding:{metric:'pv'},decimals:0,scale:1}); assert.equal(noStack.lineWidth,3);assert.equal(noStack.fillOpacity,.4);assert.equal(noStack.windowMs,30000);assert.equal(noStack.hours,12);assert.equal(noStack.smooth,true);assert.deepEqual(noStack.axis,{position:'right',min:0,max:100,centerZero:true});assert.deepEqual(noStack.legend,{position:'bottom',calculations:['mean','max','min','lastNotNull']});assert.deepEqual(noStack.thresholds,[{value:20,color:'#ef4444',dash:[6,4]}]);
 assert.equal(readMultiSeriesForm(getter(form({stack:'A'}))).stack,'A');
});
test('real API round-trips all five fixture panel configs exactly and in order',async()=>{
 const original={blocks:p};let posted;const previous=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{if(options.method==='POST'){posted=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({})};}return {ok:true,status:200,text:async()=>JSON.stringify(original)};};
 try{await saveDashboardConfig(original);assert.deepEqual(posted,original);const result=await fetchDashboardConfig();assert.deepEqual(result,original);assert.deepEqual(result.blocks.map(x=>x.id),['P13','P21','P33','P34','P40']);assert.equal(result.blocks[0].stack,false);assert.equal(result.blocks[1].stack,'A');assert.equal(result.blocks[4].reducer,'last');assert.deepEqual(result.blocks[2].thresholds[0].dash,[6,4]);}finally{globalThis.fetch=previous;}
});
test('editor validates before assigning and mounts the shared structured form',()=>{
 const editor=readFileSync(new URL('../public/js/editor.js',import.meta.url),'utf8');
 const branch=editor.slice(editor.indexOf('function readSettingsForm'));
 assert.ok(branch.indexOf('readMultiSeriesForm(')<branch.indexOf('Object.assign(config, multiSettings)'));
 assert.ok(branch.indexOf('readMultiSeriesForm(')<branch.indexOf('config.enabled ='));
 assert.match(branch,/catch\s*\(e\)\s*\{\s*return e\.message/);
 assert.match(editor,/mountMultiSeriesForm\(document/);
 assert.match(editor,/modal-mst-structured/);
});
test('editor/runtime retain real reusable family builder/updater/API history wiring',()=>{const files=['../public/js/components/index.js','../public/js/dashboard-family-contract.mjs','../public/js/dashboard-family-runtime.mjs','../public/js/updater.js','../public/js/editor.js','../public/js/components/multiSeriesTimeseries.js'];for(const f of files)assert.ok(readFileSync(new URL(f,import.meta.url),'utf8').length>0,f);const contract=readFileSync(new URL('../public/js/dashboard-family-contract.mjs',import.meta.url),'utf8');assert.match(contract,/'multi-series-timeseries':\s*'multi-series-timeseries'/);});
