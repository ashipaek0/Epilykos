import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyPhase2FormValues, normalizePhase2FamilyConfig } from '../public/js/phase2-family-settings.mjs';
import { saveDashboardConfig, fetchDashboardConfig } from '../public/js/api.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./forecast-environment-state.fixture.json',import.meta.url),'utf8'));
const config=fixture['57'];
const mappings=config.mappings;
const source=fs.readFileSync(new URL('../public/js/components/stringStateCard.js',import.meta.url),'utf8');
class Element { constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.textContent='';this.className='';} appendChild(child){this.children.push(child);} querySelector(selector){return this.children.find(child=>'.'+child.className.split(' ').join('.')===selector || child.className.split(' ').some(name=>selector==='.'+name)) || null;} }
const cards=[];
globalThis.document={createElement(tag){return new Element(tag);},querySelectorAll(selector){return selector==='.string-state-card'?cards:[];}};
const {buildStringStateCard,updateStringStateCard}=await import('../public/js/components/stringStateCard.js');
const card=buildStringStateCard({config:{binding:{metric:'rain'},label:'Rain',colorMode:'background',mappings}}); cards.push(card);
for(const [state,label,color] of [['OFF','☀️ Dry','var(--color-warning)'],['On','🌧 Raining','var(--sky-500)']]){updateStringStateCard({metrics:{rain:{value:state}}});assert.equal(card.querySelector('.string-state-value').textContent,label);assert.equal(card.style.backgroundColor,color);}
updateStringStateCard({metrics:{rain:{value:'unknown'}}});assert.equal(card.querySelector('.string-state-value').textContent,'— / No state configured');assert.equal(card.dataset.stateStatus,'no-data');
updateStringStateCard({metrics:{rain:{value:0}}});assert.equal(card.querySelector('.string-state-value').textContent,'— / No state configured');
assert.match(source,/toLowerCase\(\)/);
assert.match(source,/No state configured/);
const oldFetch=globalThis.fetch;let stored;
globalThis.fetch=async(_url,opts={})=>{if(opts.method==='POST'){stored=JSON.parse(opts.body);return{ok:true,json:async()=>({success:true})};}return{ok:true,text:async()=>JSON.stringify(stored)};};
try {
 const saved=applyPhase2FormValues('string-state',{}, {'binding.metric':'rain',label:'Rain',colorMode:'background',mappings:JSON.stringify(mappings)});
 assert.deepEqual(saved.mappings,mappings);
 assert.equal(normalizePhase2FamilyConfig('string-state',saved).binding.metric,'rain');
 await saveDashboardConfig({blocks:[{type:'string-state',config:saved}]});
 assert.deepEqual((await fetchDashboardConfig()).blocks[0].config.mappings,mappings);
} finally {globalThis.fetch=oldFetch;}
const contract=fs.readFileSync(new URL('../public/js/dashboard-family-contract.mjs',import.meta.url),'utf8');
const index=fs.readFileSync(new URL('../public/js/components/index.js',import.meta.url),'utf8');
const updater=fs.readFileSync(new URL('../public/js/updater.js',import.meta.url),'utf8');
const editor=fs.readFileSync(new URL('../public/js/editor.js',import.meta.url),'utf8');
assert.match(index,/componentBuilders[\s\S]*?'string-state':\s*buildStringStateCard/);
assert.match(contract,/'string-state':\s*'string-state'/);
assert.match(updater,/import \{ updateStringStateCard \} from '\.\/components\/stringStateCard\.js'/);
assert.match(updater,/blockTypes\.has\('string-state'\).*updateStringStateCard\(state\)/);
assert.match(editor,/case 'string-state'/);
for(const value of ['off','on']) assert(mappings.some(m=>m.value===value));
console.log('string-state-rain.test.js: PASS');
