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
async function rowFor(dev,s,answers){const h=harness({answers});const [row,msg,read]=h.ctx.settingRow(dev,s);h.rows.push(row);return {...h,row,msg,read,change:row.querySelector('.ct-change'),input:row.querySelector('input, select'),current:row.querySelector('.ct-current')};}
async function run(){let count=0;const check=(fn)=>{fn();count++};
 let r=await rowFor({name:'Pho',kind:'inverter'},{name:'enabled',label:'Enabled',description:'',type:'switch',writable:true,allowed:[]},[{ok:true,data:{value:false,capability:{allowed:[true,false]}}}]);
 check(()=>assert.equal(r.change.disabled,true)); await r.read(); check(()=>assert.equal(r.current.textContent,'Off')); check(()=>assert.equal(r.input.value,'false'));
 r.change.dataset.locked='false';r.change.disabled=false;r.input.value='true'; const p=r.change.click(); await new Promise(setImmediate); r.answer(true); await p; check(()=>assert.deepEqual(JSON.parse(JSON.stringify(r.fetches.find(x=>x.url.endsWith('/change')).body)),{device:'Pho',setting:'enabled',value:true,expected:false}));
 r=await rowFor({name:'Battery',kind:'bms'},{name:'discharging',label:'Discharging',description:'',type:'switch',writable:true,allowed:[]},[{ok:true,data:{value:'off',capability:{allowed:['on','off']}}}]);await r.read();check(()=>assert.equal(r.input.value,'off'));r.input.value='on';r.change.dataset.locked='false';r.change.disabled=false;const q=r.change.click();await new Promise(setImmediate);r.answer(true);await q;check(()=>assert.equal(r.fetches.find(x=>x.url.endsWith('/change')).body.value,'on'));
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'priority',label:'Priority',description:'',type:'select',allowed:[{value:1,label:'Solar'}],writable:false},[{ok:true,data:{value:1,capability:{allowed:[{value:1,label:'Solar first'},{value:2,label:'Battery'}],writable:true}}}]); await r.read();check(()=>assert.equal(r.input.children[1].textContent,'Solar first'));r.input.value='2';r.change.dataset.locked='false';r.change.disabled=false;const z=r.change.click();await new Promise(setImmediate);r.answer(true);await z;check(()=>assert.equal(r.fetches.find(x=>x.url.endsWith('/change')).body.value,2));
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'amps',label:'Amps',description:'Rate',type:'number',min:0,max:20,step:1,writable:false},[{ok:true,data:{value:8,capability:{min:4,max:12,step:2,writable:true}}}]);check(()=>assert.equal(r.change.disabled,true));await r.read();check(()=>assert.equal(r.input.min,4));check(()=>assert.equal(r.input.max,12));check(()=>assert.equal(r.input.step,2));
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'x',label:'X',description:'',type:'number',min:0,max:10,step:1},[{ok:true,data:{value:2}},{ok:false,status:500,data:{error:'read broke'}}]);await r.read();r.input.value='4';await r.read();check(()=>assert.equal(r.current.textContent,'—'));check(()=>assert.equal(r.input.value,''));check(()=>assert.equal(r.change.dataset.blocked,'true'));
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'x',label:'X',description:'',type:'number',min:0,max:10,step:1},[]);
 // inflight read is protected; unlock state is not a bypass for blocked/read-failed rows.
 check(()=>assert.equal(r.change.dataset.blocked,'true')); r.change.dataset.locked='false';check(()=>assert.equal(r.change.disabled,true));
 // A canceled confirmation releases the row guard without writing.
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'x',label:'X',description:'',type:'number',min:0,max:10,step:1},[{ok:true,data:{value:2}}]);await r.read();r.input.value='3';r.change.dataset.locked='false';r.change.disabled=false;const canceled=r.change.click();await Promise.resolve();check(()=>assert.equal(r.change.dataset.busy,'true'));r.answer(false);await canceled;check(()=>assert.equal(r.change.dataset.busy,undefined));check(()=>assert.equal(r.fetches.some(x=>x.url.endsWith('/change')),false));
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'x',label:'X',description:'',type:'number',min:0,max:10,step:1},[{ok:true,data:{value:2}},{ok:true,data:{value:4}}]);await r.read();r.input.value='3';r.change.dataset.locked='false';r.change.disabled=false;const a=r.change.click();await Promise.resolve();const b=r.change.click();r.answer(true);await Promise.all([a,b]);check(()=>assert.equal(r.fetches.filter(x=>x.url.endsWith('/change')).length,1));
 r=await rowFor({name:'Pho',kind:'inverter'},{name:'x',label:'X',description:'',type:'number',min:0,max:10,step:1},[{ok:true,data:{value:2}},{ok:false,data:{written:true,status:'sent_unverified',error:'unverified'}}]);await r.read();r.input.value='3';r.change.dataset.locked='false';r.change.disabled=false;const u=r.change.click();await new Promise(setImmediate);r.answer(true);await u;check(()=>assert.equal(r.change.dataset.blocked,'true'));check(()=>assert.equal(r.current.textContent,'Sent; read to check'));check(()=>assert.equal(r.fetches.filter(x=>x.url.endsWith('/change')).length,1));
 const s=harness();s.ctx.setStatus({unlockedUntil:null,writesEnabled:true,expertEnabled:true});check(()=>assert.equal(s.els.get('ct-allow').disabled,true));
 console.log(`phocos controls UI: ${count} checks passed`);checks.done(count);
}
(async()=>{
  let finished=false; const watchdog=setTimeout(()=>{if(!finished){console.error('UI fixture timed out before checks completed');process.exitCode=1;}},5000);
  process.on('beforeExit',()=>{if(!finished){console.error('UI fixture exited before all awaits/checks completed');process.exitCode=1;}});
  try { await run(); finished=true; clearTimeout(watchdog); }
  catch(e){finished=true;clearTimeout(watchdog);console.error(e);process.exitCode=1;}
})();

