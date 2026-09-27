import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSeries, reduceAndAlign, calculateCoverage, calculateLegend, buildTimeseriesChartModel, rgba, thresholdPlugin } from '../public/js/multiSeriesTimeseries.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/timeseries-multi-series.fixture.json', import.meta.url)));
test('normalizes ordered bindings and rejects unsupported reducers', () => {
 const got=normalizeSeries([{binding:{metric:'a'},label:'A',color:'#123456',unit:'W',decimals:2,scale:2,reducer:'last'},{binding:{metric:'b'},label:'B',color:'#654321',reducer:'mean'}]);
 assert.deepEqual(got.map(x=>x.binding.metric),['a','b']); assert.equal(got[0].scale,2); assert.throws(()=>normalizeSeries([{binding:{metric:'a'},reducer:'sum'}]));
});
test('excludes non-number row values while preserving numeric zero', () => {
  const start = Date.UTC(2024, 0, 1);
  const rows = [null, undefined, '', ' ', NaN, 'not-a-number', '0'].map(value => ({ timestamp: start, value }));
  rows.push({ timestamp: start + 60_000, value: 0 });
  assert.deepEqual(reduceAndAlign(rows, { start, end: start + 120_000, windowMs: 60_000 }), [{ x: start, y: null }, { x: start + 60_000, y: 0 }]);
});

test('buckets deterministic local/browser timestamps, retains zero and null gaps', () => {
 const out=reduceAndAlign([{timestamp:'2026-01-01T00:00:00',value:0},{timestamp:'2026-01-01T00:00:10',value:4}],{start:Date.parse('2026-01-01T00:00:00'),end:Date.parse('2026-01-01T00:00:20'),windowMs:10000,reducer:'mean'});
 assert.deepEqual(out.map(p=>p.y),[0,4]);
 const empty=reduceAndAlign([],{start:0,end:20000,windowMs:10000,reducer:'last'}); assert.deepEqual(empty.map(p=>p.y),[null,null]);
 assert.deepEqual(reduceAndAlign([{timestamp:0,value:2},{timestamp:1,value:4}],{start:0,end:10000,windowMs:10000,reducer:'mean'}).map(p=>p.y),[3]);
});
test('coverage uses requested windows, including empty edges and no-data',()=>{assert.deepEqual(calculateCoverage(0,100,[{x:0,y:1},{x:50,y:2}],50),{status:'complete',requestedStart:0,requestedEnd:100,actualStart:0,actualEnd:100,message:'Full requested coverage'});assert.equal(calculateCoverage(0,100,[{x:50,y:2}],50).status,'partial');assert.equal(calculateCoverage(0,100,[{x:50,y:2}],50).actualStart,50);assert.equal(calculateCoverage(0,100,[{x:0,y:1}],50).actualEnd,50);assert.equal(calculateCoverage(0,100,[],50).status,'no-data')});
test('legend excludes null and non-number values but keeps zero',()=>assert.deepEqual(calculateLegend([{y:null},{y:''},{y:'0'},{y:NaN},{y:0},{y:4}]),{mean:2,max:4,min:0,lastNotNull:4}));
test('chart model encodes style, null gaps, axes, stack, tooltip and threshold without gradients',()=>{const p=fixture.panels.find(x=>x.id==='P33');const m=buildTimeseriesChartModel(p);assert.equal(m.datasets[0].spanGaps,false);assert.equal(m.scales.y.min,0);assert.equal(m.scales.y.max,100);assert.equal(m.thresholds[0].dash[0],6);assert.equal(m.plugins.legend.position,'bottom');assert.equal(rgba('#22c55e',.25),'rgba(34,197,94,0.25)');assert.equal(fixture.panels.find(x=>x.id==='P34').axis.centerZero,true);assert.equal(fixture.panels.find(x=>x.id==='P21').stack,'A');assert.equal(fixture.panels.find(x=>x.id==='P40').series[0].reducer,'last');assert.equal(JSON.stringify(m).includes('CanvasGradient'),false)});
test('five source-safe panel contracts retain required labels and semantics',()=>{assert.equal(fixture.panels.length,5);assert.deepEqual(fixture.panels.map(p=>p.id),['P13','P21','P33','P34','P40']);assert.equal(fixture.panels[0].series.length,4);assert.equal(fixture.panels[1].series.length,5);assert.equal(fixture.panels[4].reducer,'last');assert.doesNotMatch(JSON.stringify(fixture),/sensor\.|entity_id/)});
test('threshold plugin draws current chart threshold state and supports clearing',()=>{const plugin=thresholdPlugin([{value:1,color:'red',dash:[1,2]}]);const seen=[];const chart={$multiSeriesThresholds:[{value:7,color:'blue',dash:[8,3]}],scales:{y:{getPixelForValue:v=>v*10}},ctx:{save(){},restore(){},setLineDash(v){seen.push(['dash',v])},beginPath(){},moveTo(){},lineTo(){},stroke(){},set strokeStyle(v){seen.push(['color',v])}},chartArea:{left:0,right:100}};plugin.afterDraw(chart);assert.deepEqual(seen,[['color','blue'],['dash',[8,3]]]);seen.length=0;chart.$multiSeriesThresholds=[];plugin.afterDraw(chart);assert.deepEqual(seen,[])});
test('builder and runtime expose safe threshold descriptors and refresh chart state before update',()=>{const component=readFileSync(new URL('../public/js/components/multiSeriesTimeseries.js',import.meta.url),'utf8');assert.match(component,/data-timeseries-thresholds/);assert.match(component,/textContent/);assert.match(component,/createElement/);assert.match(component,/thresholdTarget\.replaceChildren\(\)/);assert.match(component,/thresholdTarget\.hidden = thresholds\.length === 0/);assert.match(component,/Number\(threshold\.value\)/);assert.match(component,/threshold\.dash\.join\(/);assert.match(component,/threshold\.color \|\| '#ef4444'/);assert.ok(component.indexOf('chart.$multiSeriesThresholds = model.thresholds')<component.indexOf('chart.update()'))});
