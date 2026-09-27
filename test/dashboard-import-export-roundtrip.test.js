'use strict';
const assert = require('assert');
const fs = require('fs');
(async () => {
  const { serializeDashboardConfig, deserializeDashboardConfig } = await import('../public/js/dashboard-config-roundtrip.mjs');
  const template = JSON.parse(fs.readFileSync('templates/dashboard-43-panel-template.json', 'utf8'));
  const restored = deserializeDashboardConfig(serializeDashboardConfig(template));
  assert.deepStrictEqual(restored, template);
  const blocks = restored.dashboards.flatMap(d => d.layout);
  assert.strictEqual(blocks.length, 43);
  for (const [i, block] of blocks.entries()) assert.deepStrictEqual(block, template.dashboards.flatMap(d => d.layout)[i]);
  console.log('dashboard-import-export-roundtrip: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
