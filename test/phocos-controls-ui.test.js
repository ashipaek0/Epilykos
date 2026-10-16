'use strict';
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../private/js/controls.js'), 'utf8');
class El {
  constructor(tag='div') { this.tagName=tag; this.children=[]; this.dataset={}; this.listeners={}; this.attributes={}; this.classList={toggle(){},add(){},remove(){}}; this.value=''; this.textContent=''; this.disabled=false; this.min=''; this.max=''; this.step=''; this.firstChild=this; }
  set innerHTML(v) { this._html=v; for (const sel of ['.ct-set-name','.ct-help','.ct-current','input, select','.ct-change','.ct-read','label']) { const e=new El(sel==='input, select'?(v.includes('<select')?'select':'input'):sel); if(sel==='.ct-current')e.textContent='—'; if(sel==='.ct-change')e.dataset={locked:'true'}; this.map??={}; this.map[sel]=e; } }
  get innerHTML(){return this._html}
  querySelector(s){return this.map?.[s] || null}
  append(...xs){for(const x of xs)this.appendChild(x)} appendChild(x){this.children.push(x);return x}
  replaceChildren(...xs){this.children=xs}
  replaceWith(n){this.replacement=n}
  addEventListener(n,f){(this.listeners[n]??=[]).push(f)}
  setAttribute(k,v){this.attributes[k]=v} toggleAttribute(k,on){this.attributes[k]=on;return on} focus(){} checkValidity(){return true}
  click(){return Promise.all((this.listeners.click||[]).map(f=>f({preventDefault(){}})))}
}
function harness({answers=[], fetches=[]}={}) {
  const els=new Map(), rows=[]; const document={createElement:t=>new El(t),getElementById:id=>{if(!els.has(id))els.set(id,new El());return els.get(id)},querySelectorAll:sel=>sel==='[data-needs-unlock]'?rows.flatMap(row=>row.map?.['.ct-change']?[row.map['.ct-change']]:[]):[]};
  const askResolvers=[]; const ctx={document,$:id=>document.getElementById(id),fetch:async(url,opts={})=>{fetches.push({url,body:opts.body&&JSON.parse(opts.body)});const r=answers.shift()||{ok:true,status:200,data:{}};return {ok:r.ok,status:r.status||200,json:async()=>r.data||{}}},
    ask:()=>new Promise(resolve=>{askResolvers.push(resolve)}),unlocked:()=>!!ctx.status.unlockedUntil&&ctx.status.unlockedUntil+ctx.clockSkew>Date.now(),fmt:(v,u)=>v==null?'—':`${v}${u?' '+u:''}`,api:async(path,body)=>{fetches.push({url:'/api/controls'+path,body});const r=answers.shift()||{ok:true,status:200,data:{}};return r},loadLog:()=>{},setInterval:()=>1,clearInterval(){},Date,Math,Number,String,Object,Array,Set,JSON,console,status:{unlockedUntil:null,writesEnabled:false,expertEnabled:false,unlockMinutes:5},clockSkew:0,countdown:null};
  const start=source.indexOf('function settingRow('), end=source.indexOf('\nasync function loadDevices()',start);
  const ss=source.indexOf('function setStatus('), se=source.indexOf("\n$('ct-unlock-form')",ss);
  vm.createContext(ctx);vm.runInContext(source.slice(ss,se)+'\n'+source.slice(start,end)+'\nthis.settingRow=settingRow;this.setStatus=setStatus;',ctx);
  return {ctx,els,fetches,answer:v=>{const resolve=askResolvers.shift();if(!resolve)throw Error('No pending confirmation');resolve(v)},rows};
}
async function rowFor(dev,s,answers){const h=harness({answers});const [row,msg,read]=h.ctx.settingRow(dev,s);h.rows.push(row);return {...h,row,msg,read,change:row.querySelector('.ct-change'),get input(){let e=row.querySelector('input, select');while(e.replacement)e=e.replacement;return e;},current:row.querySelector('.ct-current')};}
async function run(){let count=0;const check=(fn)=>{fn();count++};
 let r=await rowFor({name:'Pho',kind:'inverter'},{name:'enabled',label:'Enabled',description:'',type:'switch',writable:true,allowed:[]},[{ok:true,data:{value:false,capability:{allowed:[true,false]}}}]);
 check(()=>assert.equal(r.change.disabled,true)); await r.read(); check(()=>assert.equal(r.current.textContent,'Off')); check(()=>assert.equal(r.input.value,'false'));
 r.change.dataset.locked='false';r.change.disabled=false;r.input.value='true'; const p=r.change.click(); await new Promise(setImmediate); r.answer(true); await p; check(()=>assert.deepEqual(JSON.parse(JSON.stringify(r.fetches.find(x=>x.url.endsWith('/change')).body)),{device:'Pho',setting:'enabled',value:true,expected:false}));
 r=await rowFor({name:'Battery',kind:'bms'},{name:'discharging',label:'Discharging',description:'',type:'switch',writable:true,allowed:[]},[{ok:true,data:{value:'off',capability:{allowed:['on','off']}}}]);await r.read();check(()=>assert.equal(r.input.value,'off'));r.input.value='on';r.change.dataset.locked='false';r.change.disabled=false;const q=r.change.click();await new Promise(setImmediate);r.answer(true);await q;check(()=>assert.equal(r.fetches.find(x=>x.url.endsWith('/change')).body.value,'on'));
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'priority',label:'Priority',description:'',type:'select',allowed:[{value:1,label:'Solar'}],writable:false},[{ok:true,data:{value:1,capability:{allowed:[{value:1,label:'Solar first'},{value:2,label:'Battery'}],writable:true}}}]); await r.read();check(()=>assert.equal(r.input.children[1].textContent,'Solar first'));r.input.value='2';r.change.dataset.locked='false';r.change.disabled=false;const z=r.change.click();await new Promise(setImmediate);r.answer(true);await z;check(()=>assert.equal(r.fetches.find(x=>x.url.endsWith('/change')).body.value,2));
 // A number setting with an allowed list becomes a dropdown of those values.
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'amps',label:'Amps',description:'Rate',type:'number',unit:'A',min:0,max:80,step:1},[{ok:true,data:{value:20,inRange:true,capability:{min:2,max:80,step:1,allowed:[2,10,20,30,40,50,60,70,80],writable:true}}},{ok:true,data:{value:30}}]);await r.read();check(()=>assert.match(r.row.querySelector('.ct-help').textContent,/Allowed values: 2 A, 10 A, 20 A/));check(()=>assert.equal(r.input.tagName,'select'));check(()=>assert.deepEqual(r.input.children.slice(1).map(o=>o.value),['2','10','20','30','40','50','60','70','80']));r.input.value='30';r.change.dataset.locked='false';r.change.disabled=false;const pick=r.change.click();await new Promise(setImmediate);r.answer(true);await pick;check(()=>assert.equal(r.fetches.find(x=>x.url.endsWith('/change')).body.value,30));
 // Set on the panel to a value off the list: named as such, and still blocked.
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'amps',label:'Amps',description:'Rate',type:'number',unit:'A',min:0,max:80,step:1},[{ok:true,data:{value:25,inRange:false,capability:{min:2,max:80,step:1,allowed:[2,10,20,30],writable:true}}}]);await r.read();check(()=>assert.match(r.msg.textContent,/reports 25 A, which isn't one of the allowed values \(2 A, 10 A, 20 A, 30 A\)/));check(()=>assert.equal(r.change.dataset.blocked,'true'));
 // Really out of range: the range is named.
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'amps',label:'Amps',description:'Rate',type:'number',unit:'A',min:0,max:80,step:1},[{ok:true,data:{value:95,inRange:false,capability:{min:2,max:80,step:1,allowed:[2,10],writable:true}}}]);await r.read();check(()=>assert.match(r.msg.textContent,/outside the supported range \(2–80 A\)/));
 // GETA schedule values must remain HH:MM strings through the shared Controls UI.
 r=await rowFor({name:'GETA',kind:'dongle'},{name:'ac_charge_start_time_1',label:'Grid start',description:'',type:'time'},[{ok:true,data:{value:'10:30',inRange:true,writable:true}},{ok:true,data:{value:'11:45'}}]);
 await r.read();check(()=>assert.match(r.row.innerHTML,/type="time"/));check(()=>assert.equal(r.input.value,'10:30'));
 r.input.value='11:45';r.change.dataset.locked='false';r.change.disabled=false;const tp=r.change.click();await new Promise(setImmediate);r.answer(true);await tp;
 check(()=>assert.equal(r.fetches.find(x=>x.url.endsWith('/change')).body.value,'11:45'));check(()=>assert.equal(r.fetches.find(x=>x.url.endsWith('/change')).body.expected,'10:30'));
 // A sent/unverified write blocks another attempt until an explicit fresh read.
 r=await rowFor({name:'GETA',kind:'dongle'},{name:'power',label:'Charging limit',description:'',type:'number',min:0,max:100,step:1},[{ok:true,data:{value:50,inRange:true,writable:true}},{ok:false,data:{written:true,status:'sent_unverified',error:'Lost reply'}}]);
 await r.read();r.input.value='49';r.change.dataset.locked='false';r.change.disabled=false;const up=r.change.click();await new Promise(setImmediate);r.answer(true);await up;
 check(()=>assert.equal(r.change.dataset.blocked,'true'));check(()=>assert.equal(r.current.textContent,'Sent; read to check'));
 const s=harness();s.ctx.setStatus({unlockedUntil:null,writesEnabled:true,expertEnabled:true});check(()=>assert.equal(s.els.get('ct-allow').disabled,true));
 console.log(`phocos controls UI: ${count} checks passed`);checks.done(count);
}
(async()=>{
  let finished=false; const watchdog=setTimeout(()=>{if(!finished){console.error('UI fixture timed out before checks completed');process.exitCode=1;}},5000);
  process.on('beforeExit',()=>{if(!finished){console.error('UI fixture exited before all awaits/checks completed');process.exitCode=1;}});
  try { await run(); finished=true; clearTimeout(watchdog); }
  catch(e){finished=true;clearTimeout(watchdog);console.error(e);process.exitCode=1;}
})();

