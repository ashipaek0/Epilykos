import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyPhase2FormValues, normalizePhase2FamilyConfig } from '../public/js/phase2-family-settings.mjs';
import { normalizeStatConfig } from '../public/js/stat-parity.mjs';
import { saveDashboardConfig, fetchDashboardConfig } from '../public/js/api.js';
const stat = applyPhase2FormValues('stat-metric', {}, {metric:'pv',label:'Solar',reducer:'lastNotNull',unit:'W',precision:'2',min:'0',max:'100',colorMode:'fixed',fixedColor:'#f00',thresholds:'[{"value":2,"color":"red"},{"value":2,"color":"blue"}]',sparkline:'area','fallback.enabled':true,'fallback.value':'0','fallback.label':'n/a'});
const gauge = applyPhase2FormValues('segmented-gauge', {}, {metric:'soc',label:'SOC',reducer:'lastNotNull',unit:'%',min:'0',max:'100',segments:'5',spacing:'2',thresholds:'[{"value":20,"color":"amber"},{"value":20,"color":"red"}]',markers:true,labels:true,endpoint:'point',sparkline:'none','fallback.enabled':false,'fallback.value':'','fallback.label':''});
assert.equal(stat.thresholds.length, 2); assert.equal(stat.thresholds[0].value, stat.thresholds[1].value); assert.equal(gauge.thresholds.length, 2);
assert.equal(normalizeStatConfig({...stat,fallback:{...stat.fallback,enabled:true,label:'n/a'}}).fallback.enabled,true);
for (const cfg of [stat, normalizePhase2FamilyConfig('stat-metric',stat), normalizeStatConfig(stat)]) { assert.equal(cfg.min,0); assert.equal(cfg.max,100); }
const src=fs.readFileSync(new URL('../public/js/editor.js',import.meta.url),'utf8');
assert.match(src,/case 'stat-metric':[\s\S]*?buildPhase2FamilyForm/); assert.match(src,/applyPhase2FormValues/);
assert.match(src,/select\('reducer',c\.reducer,\['lastNotNull'\]\)/);
assert.match(src,/\['binding\.metric','label','reducer'/);
assert.match(src,/value === option \? ' selected' : ''/);
assert.match(src,/select\(k,c\[k\],\['value','background','fixed'\]\)/);
assert.match(src,/select\(k,c\[k\],\['area','none'\]\)/);
assert.match(src,/select\(k,c\[k\],\['point','none'\]\)/);
assert.match(src,/name\.replace\(\/\[\^a-z0-9\]\/gi,'-'\)/);
for (const value of ['value','background','fixed','area','none','point']) assert.match(src,new RegExp("'" + value + "'"));
for (const [type, values, key, fallback] of [
  ['stat-metric',{colorMode:'invalid',sparkline:'invalid'},'colorMode','value'],
  ['stat-metric',{colorMode:'fixed',sparkline:'invalid'},'sparkline','area'],
  ['segmented-gauge',{endpoint:'invalid',sparkline:'invalid'},'endpoint','point'],
  ['segmented-gauge',{endpoint:'none',sparkline:'invalid'},'sparkline','area']
]) assert.equal(applyPhase2FormValues(type,{},values)[key],fallback);
for (const type of ['stat-metric','segmented-gauge']) assert.equal(applyPhase2FormValues(type,{}, {reducer:'invalid'}).reducer,'lastNotNull');
const oldFetch=globalThis.fetch; let stored;
globalThis.fetch=async (_url,opts={})=>{ if(opts.method==='POST'){stored=JSON.parse(opts.body);return {ok:true,json:async()=>({success:true})};} return {ok:true,text:async()=>JSON.stringify(stored)}; };
try { await saveDashboardConfig({blocks:[{type:'stat-metric',config:stat},{type:'segmented-gauge',config:gauge}]}); const postStat=stored.blocks[0].config; assert.equal(postStat.min,0); assert.equal(postStat.max,100); const got=await fetchDashboardConfig(); assert.deepEqual(got.blocks[0].config,stat); assert.equal(got.blocks[0].config.min,0); assert.equal(got.blocks[0].config.max,100); assert.deepEqual(got.blocks[1].config,gauge); } finally {globalThis.fetch=oldFetch;}
console.log('stat-editor-roundtrip.test.js: passed');
