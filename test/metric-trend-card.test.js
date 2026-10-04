'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.style={setProperty(k,v){this[k]=v;}};this.dataset={};this.hidden=false;this.isConnected=true;this.textContent='';this.className='';this.classList={add:(s)=>{this.className+=(this.className?' ':'')+s;},contains:(s)=>this.className.split(/\s+/).includes(s)};}
 append(...nodes){this.children.push(...nodes);}
 prepend(node){this.children.unshift(node);}
 setAttribute(k,v){this.attributes[k]=String(v);}
 removeAttribute(k){delete this.attributes[k];}
 querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
 querySelectorAll(sel){const cls=sel.startsWith('.')?sel.slice(1):null;return this.children.flatMap(n=>[(cls&&n.classList.contains(cls))?n:null,...n.querySelectorAll(sel)]).filter(Boolean);}
}
const source=fs.readFileSync(path.join(__dirname,'../public/js/components/metricTrendCard.js'),'utf8')
 .replace(/^import .*;\n/gm,'').replace(/export function /g,'function ');
const cards=[];
let resolvePending;
const pendingForecast=new Promise(resolve=>{resolvePending=resolve;});
const sandbox={document:{createElement:t=>new Node(t),createElementNS:(_ns,t)=>new Node(t),querySelectorAll:()=>cards},
 normalizeMetricTrendConfig:x=>({...{preset:'subtle-area',title:'',icon:'',value:{metric:'solar_kw'},graph:{enabled:false,source:'none'},display:{compact:false,align:'center',valueFontSize:40,unitFontSize:16},style:{padding:16,radius:12,bodyFill:'',bodyFillEnd:'',valueColor:'',unitColor:''}},...x,value:{metric:'solar_kw',...x?.value},graph:{enabled:false,source:'none',...x?.graph},display:{compact:false,align:'center',valueFontSize:40,unitFontSize:16,...x?.display},style:{padding:16,radius:12,bodyFill:'',bodyFillEnd:'',valueColor:'',unitColor:'',...x?.style}}),
 trendValueFromState:(state,c)=>state?.metrics?.[c.value.metric]?.value??null,formatTrendValue:v=>({value:String(v),unit:'W'}),historyTrendPath:()=>'',historyTrendAreaPath:()=>'',historyUrl:()=>'',forecastValue:()=>12,forecastGraphPoints:()=>[],serverForecastDate:()=> '2026-10-04',getSharedForecastData:()=>pendingForecast,renderIcon:()=>'<svg aria-hidden="true"></svg>',fetch:()=>Promise.resolve({ok:true,json:async()=>[]}),Date,Map,JSON,Promise,console};
vm.runInNewContext(`${source}; globalThis.build=buildMetricTrendCard; globalThis.update=updateMetricTrendCards;`,sandbox);
const filled=sandbox.build({id:'block-1',config:{preset:'filled-body',title:'Battery',icon:'battery',display:{compact:true},style:{bodyFill:'#123456',bodyFillEnd:'#abcdef'}}});
assert.ok(filled.classList.contains('metric-trend-card'));
const header=filled.querySelector('.metric-trend-header'),body=filled.querySelector('.metric-trend-body');
assert.ok(header && body);assert.ok(header.querySelector('.metric-trend-icon').innerHTML.includes('<svg'));
assert.equal(header.querySelector('.metric-trend-title').textContent,'Battery');
assert.equal(body.style.backgroundColor,'#123456');assert.match(body.style.backgroundImage,/linear-gradient/);
assert.equal(filled.style.backgroundColor,undefined);assert.equal(filled.querySelector('.metric-trend-readout').classList.contains('is-compact'),true);
assert.ok(body.querySelector('.metric-trend-value'));assert.ok(body.querySelector('.metric-trend-unit'));assert.ok(body.querySelector('.metric-trend-graph-wrap').hidden);
const subtle=sandbox.build({config:{preset:'subtle-area',style:{bodyFill:'#112233'}}});
assert.equal(subtle.querySelector('.metric-trend-body').style.backgroundColor,'#112233');
console.log('metric trend card tests passed (runtime DOM structure)');
(async()=>{
 const card=sandbox.build({id:'race',config:{value:{source:'solar-forecast',forecastSource:'default',forecastValue:'today-total'}}});cards.push(card);
 sandbox.update({});
 card.dataset.config=JSON.stringify({value:{source:'metric',metric:'pv_power',unit:'W'}});
 sandbox.update({metrics:{pv_power:{value:37,unit:'W'}}});
 resolvePending({});
 await pendingForecast; await Promise.resolve(); await Promise.resolve();
 assert.equal(card.querySelector('.metric-trend-value').textContent,'37');
 assert.equal(card.querySelector('.metric-trend-unit').textContent,'W');
 assert.equal(card.querySelector('.metric-trend-status').textContent,'');
 console.log('metric trend async source-switch regression passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
