import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveStat, formatStatValue, evaluateThreshold, normalizeStatConfig } from '../public/js/stat-parity.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./forecast-environment-state.fixture.json',import.meta.url),'utf8'));
for (const [id,panel] of Object.entries(fixture.panels)) {
 const cfg=normalizeStatConfig({...panel,binding:{metric:`panel-${id}`}});
 assert.equal(cfg.binding.metric,`panel-${id}`);
 assert.equal(cfg.unit,panel.unit);
 if (Object.hasOwn(panel,'decimals')) assert.equal(formatStatValue(12.345,cfg.unit,panel.decimals),`${(12.345).toFixed(panel.decimals)} ${panel.unit}`);
 else assert.equal(Object.hasOwn(cfg,'decimals'),false);
 const at=panel.thresholds.map(t=>resolveStat(cfg.binding,{[`panel-${id}`]:t.value}));
 assert.deepEqual(at.map(x=>evaluateThreshold(x.value,cfg.thresholds)),panel.thresholds.map(t=>t.color));
 assert.equal(resolveStat(cfg.binding,{[`panel-${id}`]:null}).status,'no-data');
}
console.log('forecast-card-parity.test.js: PASS');
