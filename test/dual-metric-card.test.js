'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Node {
  constructor(tag) { this.tagName=tag; this.children=[]; this.style={setProperty(k,v){this[k]=v;}}; this.dataset={}; this.attributes={}; this.className=''; this.textContent=''; this.listeners={}; this.classList={add:s=>{this.className+=(this.className?' ':'')+s;},toggle:(s,on)=>{if(on&&!this.classList.contains(s))this.classList.add(s);},contains:s=>this.className.split(/\s+/).includes(s)}; }
  append(...nodes){this.children.push(...nodes);}
  setAttribute(k,v){this.attributes[k]=String(v);}
  addEventListener(k,fn){this.listeners[k]=fn;}
  focus(){this.focused=true;}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  querySelectorAll(s){const cls=s.startsWith('.')?s.slice(1):'';return this.children.flatMap(n=>[(cls&&n.classList.contains(cls))?n:null,...n.querySelectorAll(s)]).filter(Boolean);}
}
const project = path.join(__dirname, '..');
const formatSrc=fs.readFileSync(path.join(project,'public/js/components/format.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
const utilSrc=fs.readFileSync(path.join(project,'public/js/utils.js'),'utf8').replace(/export /g,'');
const formatBox={Intl,Map}; vm.runInNewContext(`${utilSrc}\n${formatSrc};globalThis.formatMetric=formatMetric;`,formatBox);
const logicSrc=fs.readFileSync(path.join(project,'public/js/components/dualMetricLogic.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
const logicBox={formatMetric:formatBox.formatMetric}; vm.runInNewContext(`${logicSrc};globalThis.normalizeDualMetricConfig=normalizeDualMetricConfig;globalThis.resolveDualMetricPane=resolveDualMetricPane;`,logicBox);
let cards=[];
const cardSrc=fs.readFileSync(path.join(project,'public/js/components/dualMetricCard.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export function /g,'function ');
const sandbox={document:{createElement:t=>new Node(t),querySelectorAll:()=>cards},normalizeDualMetricConfig:logicBox.normalizeDualMetricConfig,resolveDualMetricPane:logicBox.resolveDualMetricPane,renderIcon:id=>id==='battery'?'<svg></svg>':''};
vm.runInNewContext(`${cardSrc};globalThis.build=buildDualMetricCard;globalThis.update=updateDualMetricCards;`,sandbox);

test('builder creates exactly two independently bound panes and safe authored text/styles', () => {
  const card=sandbox.build({id:'b1',config:{title:'<img src=x>',icon:'unknown',helpText:'<script>help</script>',preset:'split-fill',panes:{left:{metric:'a',label:'<b>left</b>',unit:'W',fillColor:'#123456',valueFontSize:52},right:{metric:'b',label:'right',fillColor:'#abcdef'}},style:{padding:20,paneGap:4,dividerWidth:2,dividerColor:'#777'}}});
  assert.equal(card.className.includes('dual-metric-card'),true);
  assert.equal(card.querySelectorAll('.dual-metric-header').length,1);
  assert.equal(card.querySelectorAll('.dual-metric-pane').length,2);
  assert.equal(card.querySelector('.dual-metric-title').textContent,'<img src=x>');
  assert.equal(card.querySelector('.dual-metric-pane-left').querySelector('.dual-metric-label').textContent,'<b>left</b>');
  assert.equal(card.querySelector('.dual-metric-icon'),null);
  assert.equal(card.querySelector('.dual-metric-help-text').textContent,'<script>help</script>');
  assert.equal(card.style['--dual-padding'],'20px'); assert.equal(card.style['--dual-pane-gap'],'4px');
  assert.equal(card.style['--dual-divider-width'],'2px');
  assert.equal(card.querySelector('.dual-metric-pane-left').style['--dual-value-size'],'52px');
  assert.equal(card.querySelector('.dual-metric-pane-left').style.backgroundColor,'#123456');
  const helpButton=card.querySelector('.dual-metric-help');
  assert.equal(helpButton.attributes['aria-describedby'],card.querySelector('.dual-metric-help-text').id);
  helpButton.listeners.click(); assert.equal(card.querySelector('.dual-metric-help-text').hidden,false);
  assert.equal(helpButton.attributes['aria-expanded'],'true');
  helpButton.listeners.keydown({key:'Escape'});
  assert.equal(card.querySelector('.dual-metric-help-text').hidden,true);
  assert.equal(helpButton.attributes['aria-expanded'],'false');
  assert.equal(helpButton.focused,true);
});

test('updater paints independent values, signs, units, zero and status without hiding valid peer', () => {
  const card=sandbox.build({config:{preset:'neutral',panes:{left:{metric:'watts',unit:'W',precision:2},right:{metric:'stale',unit:'V'}}}}); cards=[card];
  sandbox.update({metrics:{watts:{value:1000,unit:'W',quality:'good'},stale:{value:7,unit:'V',quality:'stale'}}});
  const left=card.querySelector('.dual-metric-pane-left'),right=card.querySelector('.dual-metric-pane-right');
  assert.equal(left.querySelector('.dual-metric-value').textContent,'1.00'); assert.equal(left.querySelector('.dual-metric-unit').textContent,'kW');
  assert.equal(left.querySelector('.dual-metric-status').textContent,'');
  assert.equal(right.querySelector('.dual-metric-value').textContent,'—'); assert.equal(right.querySelector('.dual-metric-status').textContent,'Stale');
  sandbox.update({metrics:{watts:{value:-796,unit:'W',quality:'good'},stale:{value:0,unit:'V',quality:'good'}}});
  assert.equal(left.querySelector('.dual-metric-value').textContent,'-796.00'); assert.equal(left.querySelector('.dual-metric-unit').textContent,'W');
  assert.equal(right.querySelector('.dual-metric-value').textContent,'0.0'); assert.equal(right.querySelector('.dual-metric-status').textContent,'');
});

test('value, label and unit colors are independent and readout alignment follows each pane', () => {
  const card=sandbox.build({config:{panes:{left:{metric:'a',valueColor:'#aa0000',labelColor:'#00aa00',unitColor:'#0000aa',align:'left'},right:{metric:'b',valueColor:'#bb0000',align:'right'}}}});
  const left=card.querySelector('.dual-metric-pane-left'),right=card.querySelector('.dual-metric-pane-right');
  assert.equal(left.style.color,undefined); assert.equal(right.style.color,undefined);
  assert.equal(left.querySelector('.dual-metric-label').style.color,'#00aa00');
  assert.equal(left.querySelector('.dual-metric-value').style.color,'#aa0000');
  assert.equal(left.querySelector('.dual-metric-unit').style.color,'#0000aa');
  assert.equal(left.querySelector('.dual-metric-readout').style.justifyContent,'flex-start');
  assert.equal(right.querySelector('.dual-metric-readout').style.justifyContent,'flex-end');
  const css=fs.readFileSync(path.join(project,'public/style.css'),'utf8');
  assert.match(css,/\.dual-metric-status\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(css,/\.dual-metric-status:empty\s*\{[^}]*display:\s*none/s);
});

test('help affordance is omitted when empty; neutral ignores pane fill and clamps style variables', () => {
  const card=sandbox.build({config:{panes:{left:{fillColor:'#123456'},right:{}},style:{padding:200,dividerWidth:200}}});
  assert.equal(card.querySelector('.dual-metric-help'),null);
  assert.equal(card.style['--dual-padding'],'32px'); assert.equal(card.style['--dual-divider-width'],'0px');
  assert.equal(card.querySelector('.dual-metric-pane-left').style.backgroundColor,'');
});
