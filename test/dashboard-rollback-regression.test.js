'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const removedFamilies = [
  'stat-metric', 'segmented-gauge', 'multi-series-timeseries',
  'multi-series-bar-gauge', 'static-text', 'string-state'
];
const sourceFiles = [
  'public/editor.html', 'public/js/editor.js', 'public/js/updater.js',
  'public/js/components/index.js', 'public/style.css', 'routes/metrics.js'
];
const production = sourceFiles.map(read).join('\n');
for (const family of removedFamilies) {
  assert.equal(production.includes(family), false, `dangling family reference: ${family}`);
}
for (const removed of [
  'public/js/dashboard-43-presets.mjs',
  'public/js/dashboard-presets.mjs',
  'public/js/dashboard-config-roundtrip.mjs',
  'public/js/dashboard-family-contract.mjs',
  'public/js/dashboard-family-runtime.mjs',
  'public/js/phase2-family-settings.mjs',
  'public/js/multiSeriesSettingsForm.mjs',
  'public/js/multiSeriesBarGaugeSettings.mjs',
  'templates/dashboard-43-panel-template.json'
]) assert.equal(fs.existsSync(path.join(root, removed)), false, `obsolete file remains: ${removed}`);

const editor = read('public/js/editor.js');
const api = read('public/js/api.js');
const components = read('public/js/components/index.js');
assert.doesNotMatch(editor, /dashboard-preset|dashboard-43|preset-section-heading|multi-series|stat-metric|segmented-gauge|string-state|static-text/);
assert.match(editor, /case 'chart-metric'/);
assert.match(editor, /case 'text-card'/);
assert.match(editor, /case 'metric-cards'/);
// Builders are looked up by block type in a Map built from componentBuilders
// (no inherited properties such as "constructor" can resolve to a callable).
assert.match(editor, /new Map\(Object\.entries\(componentBuilders\)\)/);
assert.match(editor, /BLOCK_BUILDERS\.get\(block\.type\)/);
assert.match(editor, /if \(typeof builder !== 'function'\) return null;/, 'unknown/removed card types must be skipped safely');
assert.match(editor, /Array\.isArray\(imported\.dashboards\)/, 'imports must validate dashboards as an array');
// Imports ask for an explicit Append or Replace choice in a dialog (radio
// cards named importMode); nothing is imported without that choice.
assert.match(editor, /input\.name = 'importMode';/, 'imports must require explicit Append or Replace confirmation');
assert.match(editor, /var choice = form\.elements\.importMode\.value;/, 'import choice must come from the dialog');
const importHelper = editor.match(/function applyDashboardImport\([\s\S]*?\n\}/);
assert.ok(importHelper, 'dashboard imports must use the tested pure import helper');
const uniqueIdHelper = editor.match(/function uniqueDashboardId\([\s\S]*?\n\}/);
assert.ok(uniqueIdHelper, 'Append must resolve duplicate dashboard IDs');
const importContext = { Set, JSON, Error };
vm.runInNewContext(`${uniqueIdHelper[0]}; ${importHelper[0]}; this.applyDashboardImport = applyDashboardImport;`, importContext);
const existing = { activeDashboard: 'home', dashboards: [{ id: 'home', name: 'Existing' }] };
const before = JSON.stringify(existing);
assert.throws(() => importContext.applyDashboardImport(existing, { dashboards: [{ id: 'new', name: 'Valid' }, null] }, 'Append'), /dashboard/i);
assert.equal(JSON.stringify(existing), before, 'malformed Append must not mutate existing config');
assert.throws(() => importContext.applyDashboardImport(existing, { dashboards: [{ id: '   ' }] }, 'Replace'), /id/i);
assert.equal(JSON.stringify(existing), before, 'malformed Replace must not mutate existing config');
const appended = importContext.applyDashboardImport(existing, { dashboards: [{ id: 'home', name: 'Imported' }] }, 'Append');
assert.deepEqual(Array.from(appended.dashboards, dashboard => dashboard.id), ['home', 'home_2']);
const replaced = importContext.applyDashboardImport(existing, { dashboards: [{ id: 'fresh', name: 'Fresh' }] }, 'Replace');
assert.deepEqual(Array.from(replaced.dashboards, dashboard => dashboard.id), ['fresh']);
assert.match(editor, /choice !== 'Append' && choice !== 'Replace'/, 'all other import confirmations must cancel');

// #136 remains intact while the #132 serializer dependency is removed.
assert.match(api, /return fetchJson\('\/api\/dashboard-state'\)/);
assert.match(api, /return fetchJson\('\/api\/public-config'\)/);
assert.match(api, /Invalid API response/);
assert.match(api, /fetch\('\/api\/dashboard-config'/);
assert.match(api, /JSON\.stringify\(config\)/);
assert.doesNotMatch(api, /dashboard-config-roundtrip/);

// Preserve the exact pre-#132 registry, including chart-metric and text-card.
const olderCards = [
  'flow-card', 'forecast-banner', 'forecast-sparkline', 'forecast-info',
  'metric-cards', 'grid-card', 'chart-power', 'chart-energy', 'chart-metric',
  'text-metric', 'savings-summary', 'data-table-daily', 'data-table-monthly',
  'flow-card-2', 'multi-value', 'gauge-card', 'half-gauge', 'half-gauge-2',
  'flow-card-square', 'flow-card-square-2', 'text-card', 'iframe-card',
  'forecast-pvtoday', 'bar-gauge', 'bar-gauge-retro', 'bar-single',
  'bar-stacked', 'bar-threshold', 'weather-block', 'switch-block', 'state-select'
];
for (const card of olderCards) assert.match(components, new RegExp(`['"]${card}['"]\\s*:`), `older card removed: ${card}`);
for (const family of removedFamilies) assert.doesNotMatch(components, new RegExp(`['"]${family}['"]`));
assert.match(read('public/js/updater.js'), /chart-metric/);

// #133 deterministic time injection and #134 branding assets remain present.
const { openMeteoPayload } = require('./open-meteo-fixture');
const frozenNow = new Date(2026, 0, 2, 3, 4, 0);
assert.ok(openMeteoPayload(frozenNow).hourly.time.includes('2026-01-02T03:04'));
for (const asset of [
  'public/icons/epilykos-mark.svg', 'public/icons/epilykos-mark-light.svg',
  'public/icons/epilykos-mark-dark.svg', 'public/favicon.ico',
  'public/icons/icon-192.png', 'public/icons/icon-512.png'
]) assert.equal(fs.existsSync(path.join(root, asset)), true, `#134 asset removed: ${asset}`);

console.log('dashboard rollback removal/preservation regression: PASS');
