import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/editor.js', import.meta.url), 'utf8');
function extract(name, next) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `source range for ${name}`);
  return source.slice(start, end);
}
function sandbox() {
  const context = { BREAKDOWN_VALUE_TYPES: [], buildBreakdownFields: () => '', readBreakdownFields: () => {}, availableMetrics: ['PV Power', 'Grid Power'], escHtml: s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])), Intl, Set, Array, Number, String, Object, JSON, isFinite };
  vm.createContext(context);
  vm.runInContext(extract('hexForPicker', '\nfunction buildConfigurableGaugeForm('), context);
  vm.runInContext(extract('buildPowerStatsForm', '\nfunction renderPowerStatsColumns'), context);
  vm.runInContext(extract('readSettingsForm', '\n// ── Block content'), context);
  return context;
}

test('power chart dataset normalization keeps forward-compatible series options', () => {
  const chartSource=fs.readFileSync(new URL('../public/js/components/chartPower.js',import.meta.url),'utf8');
  const start=chartSource.indexOf('function normalizeDatasets('), end=chartSource.indexOf('\nexport function buildChartPower',start);
  const ctx={getComputedStyle(){return {getPropertyValue(){return '#888';}};},document:{documentElement:{}}};
  vm.createContext(ctx);vm.runInContext(chartSource.slice(start,end),ctx);
  const data=ctx.normalizeDatasets([{metric:'solar',label:'PV',color:'#f59e0b',axis:'right',futureSeries:{mode:'keep'}}]);
  assert.equal(data[0].axis,'right');assert.equal(data[0].futureSeries.mode,'keep');
});

test('power statistics table styles honor alignment, density, and local overflow at any width', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.power-stats-table thead th\s*\{[^}]*text-align:\s*var\(--power-stats-header-align,\s*start\)/s);
  assert.match(css, /\.power-stats-table tbody th\s*\{[^}]*text-align:\s*var\(--power-stats-label-align,\s*start\)/s);
  assert.match(css, /\.power-stats-table tbody td\s*\{[^}]*text-align:\s*var\(--power-stats-value-align,\s*end\)/s);
  assert.match(css, /\.power-stats\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.power-stats-table\.density-compact/);
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*390px\)[^{]*\{[^}]*\.power-stats/s);
});

test('power chart stats form exposes typed, documented feature settings', () => {
  const c = sandbox();
  const html = c.buildPowerStatsForm({stats:{enabled:true,columns:[{key:'last',label:'Latest',precision:2,showTimestamp:true,staleAfterSeconds:60}]}});
  for (const field of ['ps-enabled','ps-title-visible','ps-header-visible','ps-hidden-series','ps-density','ps-locale','ps-grouping','ps-zero','ps-nodata','labelAlign','valueAlign','fontWeight','border','ps-fontsize','ps-spacing','ps-color','ps-swatches','ps-tooltip','ps-columns-data']) assert.match(html,new RegExp(field));
  assert.match(source,/class="ps-stale"/);
  assert.doesNotMatch(html,/data-ps-style="headerAlign"/,'headings follow their column alignment');
  assert.match(source,/class="ps-precision" type="number"[^>]*placeholder="Auto"/);
  assert.match(source,/value="' \+ escHtml\(c\.precision == null \? '' : c\.precision\)/);
  assert.match(html,/Latest/);
});

test('chart-power saves full stats and appearance while retaining unknown nested fields', () => {
  const c=sandbox(), values={
    'modal-enabled':true,'modal-transparent':false,'modal-bgcolor':'','modal-fontcolor':'','modal-fontsize':'','modal-chart-hidegrid':false,'modal-chart-fill':true,'modal-chart-title':'Power',
    'pca-height':'440','pca-width':'3','pca-opacity':'0.6','pca-style':'dashed','pca-markers':true,'pca-unit':'kW','pca-legend':true,'pca-tooltip':true,
    'pca-left-unit':'W','pca-left-scale':'linear','pca-left-min':'','pca-left-max':'2000','pca-right-unit':'kW','pca-right-scale':'linear','pca-right-min':'-2','pca-right-max':'4',
    'ps-columns-data':{textContent:JSON.stringify([{key:'mean',label:'Average',precision:2,customColumn:'keep'},{key:'last',label:'Latest',precision:1,showTimestamp:true,staleAfterSeconds:100,customLast:true}])},
    'chart-data':{textContent:JSON.stringify([{label:'PV',metric:'PV Power',customDataset:11}])},
    'ps-enabled':true,'ps-title-visible':true,'ps-header-visible':false,'ps-hidden-series':true,'ps-title':'Stats','ps-density':'compact','ps-locale':'en-US','ps-grouping':false,'ps-zero':'Zero','ps-nodata':'n/a','ps-fontsize':'16','ps-spacing':'6','ps-color':'#123456','ps-swatches':false,'ps-tooltip':true
  };
  const colRows=[['mean','Average','',true],['last','Latest',1,false]];
  function fakeRow([key,label,precision,visible],last){return {querySelector(sel){const map={'.ps-key':{value:key},'.ps-label':{value:label},'.ps-precision':{value:String(precision)},'.ps-visible':{checked:visible},'.ps-timestamp':{checked:true},'.ps-stale':{value:'120'}};return map[sel]||null;}};}
  const styleValues={headerAlign:'center',labelAlign:'start',valueAlign:'end',fontWeight:'bold',border:'subtle'};
  c.document={getElementById(id){const value=values[id]; if(value==null)return null; if(typeof value==='object')return value; return {value:String(value),checked:!!value,dataset:{}};},querySelector(sel){const m=sel.match(/data-ps-style="([^"]+)/);return m?{value:styleValues[m[1]]}:null;},querySelectorAll(sel){if(sel==='#ps-columns .ps-column-row')return colRows.map((r,i)=>fakeRow(r,i===1));if(sel==='.chart-stats-visible')return [{checked:false}];if(sel==='.chart-stats-label')return [{value:'Solar Output'}];if(sel==='.chart-stats-precision')return [{value:'3'}];if(sel==='.chart-row')return [{}];return [];}};
  const block={type:'chart-power',config:{datasets:[{label:'PV',metric:'PV Power',customDataset:11}],stats:{customStats:'preserve',tableStyle:{futureStyle:22},format:{futureFormat:33},series:{'PV Power':{futureSeries:true}}},appearance:{futureAppearance:44,axes:{left:{futureAxis:55}}}}};
  assert.equal(c.readSettingsForm(block),null);
  assert.deepEqual(JSON.parse(JSON.stringify(block.config.stats.columns)).map(x=>x.customColumn||x.customLast),['keep',true]);
  assert.equal(block.config.stats.customStats,'preserve');
  assert.equal(block.config.stats.tableStyle.futureStyle,22);
  assert.equal(block.config.stats.format.futureFormat,33);
  assert.equal(block.config.stats.series['PV Power'].futureSeries,true);
  assert.equal(block.config.stats.series['PV Power'].visible,false);
  assert.equal(block.config.stats.series['PV Power'].label,'Solar Output');
  assert.equal(block.config.stats.series['PV Power'].precision,3);
  assert.equal(Object.hasOwn(block.config.stats.columns[0],'precision'),false);
  assert.equal(block.config.appearance.futureAppearance,44);
  assert.equal(block.config.appearance.axes.left.futureAxis,55);
  assert.equal(block.config.appearance.axes.left.max,2000);
  assert.equal(block.config.appearance.axes.right.min,-2);
  assert.equal(block.config.datasets[0].customDataset,11);
});

test('font size above 24 is rejected before mutating existing chart config',()=>{const c=sandbox(),values={'modal-enabled':true,'modal-transparent':false,'modal-bgcolor':'','modal-fontcolor':'','modal-fontsize':'','pca-height':'320','pca-width':'2','pca-opacity':'0.7','pca-left-unit':'W','pca-left-scale':'linear','pca-left-min':'','pca-left-max':'','pca-right-unit':'W','pca-right-scale':'linear','pca-right-min':'','pca-right-max':'','pca-style':'solid','pca-unit':'kW','pca-markers':false,'pca-legend':true,'pca-tooltip':true,'ps-columns-data':{textContent:'[]'},'ps-fontsize':'25','ps-spacing':'8','ps-color':'theme','ps-locale':'auto','ps-enabled':true,'ps-title-visible':true,'ps-header-visible':true,'ps-hidden-series':false,'ps-title':'Stats','ps-density':'comfortable','ps-grouping':true,'ps-zero':'0','ps-nodata':'—','ps-swatches':true,'ps-tooltip':true,'modal-chart-hidegrid':false,'modal-chart-fill':true,'chart-data':{textContent:'[]'}};c.document={getElementById(id){const v=values[id];if(v==null)return null;if(typeof v==='object')return v;return {value:String(v),checked:!!v,dataset:{}};},querySelector(sel){return {value:sel.includes('fontWeight')?'normal':sel.includes('border')?'subtle':'start'};},querySelectorAll(){return [];}};const original={type:'chart-power',config:{stats:{enabled:false,unknown:'intact'},datasets:[]}};assert.match(c.readSettingsForm(original),/font size or row spacing/);assert.equal(original.config.stats.enabled,false);assert.equal(original.config.stats.unknown,'intact');});
test('invalid stats precision prevents config mutation', () => {
  const c=sandbox(), values={'modal-enabled':true,'pca-width':'2','pca-opacity':'0.7','pca-left-unit':'W','pca-left-scale':'linear','pca-left-min':'','pca-left-max':'','pca-right-unit':'W','pca-right-scale':'linear','pca-right-min':'','pca-right-max':'','pca-style':'solid','pca-unit':'kW','pca-markers':false,'pca-legend':true,'pca-tooltip':true,'pca-left-unit':'W','pca-left-scale':'linear','pca-right-unit':'W','pca-right-scale':'linear','ps-columns-data':{textContent:'[]'},'ps-fontsize':'14','ps-spacing':'8','ps-color':'theme','ps-locale':'auto'};
  c.document={getElementById(id){const v=values[id];if(v==null)return null;if(typeof v==='object')return v;return {value:String(v),checked:!!v,dataset:{}};},querySelector(){return {value:'start'};},querySelectorAll(sel){return sel==='#ps-columns .ps-column-row'?[{querySelector(s){return s==='.ps-key'?{value:'mean'}:s==='.ps-label'?{value:'Mean'}:s==='.ps-precision'?{value:'99'}:{checked:true};}}]:[];}};
  const original={type:'chart-power',config:{stats:{enabled:false,unknown:'intact'}}};
  assert.match(c.readSettingsForm(original),/precision/);
  assert.equal(original.config.stats.enabled,false);
  assert.equal(original.config.stats.unknown,'intact');
});
