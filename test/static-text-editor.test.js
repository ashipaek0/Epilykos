import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyPhase2FormValues } from '../public/js/phase2-family-settings.mjs';
import { saveDashboardConfig, fetchDashboardConfig } from '../public/js/api.js';
const content='<img src=x onerror=alert(1)> & literal';
const config=applyPhase2FormValues('static-text',{}, {content});
assert.equal(config.content,content);
const src=fs.readFileSync(new URL('../public/js/editor.js',import.meta.url),'utf8');
assert.match(src,/case 'static-text':/);
const oldFetch=globalThis.fetch; let stored;
globalThis.fetch=async (_url,opts={})=>{if(opts.method==='POST'){stored=JSON.parse(opts.body);return {ok:true,json:async()=>({success:true})};}return {ok:true,text:async()=>JSON.stringify(stored)};};
try{await saveDashboardConfig({blocks:[{type:'static-text',config}]});const loaded=await fetchDashboardConfig();assert.equal(loaded.blocks[0].config.content,content);}finally{globalThis.fetch=oldFetch;}
console.log('static-text-editor.test.js: passed');
