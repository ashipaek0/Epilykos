'use strict';
const assert = require('assert');
const fs = require('fs');
const { periodBindingWarning } = require('../public/js/periodStat.mjs');
const template = JSON.parse(fs.readFileSync('templates/dashboard-43-panel-template.json', 'utf8'));
const blocks = template.dashboards.flatMap(d => d.layout);
const suspicious = /sensor\.|\bNigeria\b|\b20\d{2}-\d{2}-\d{2}\b|\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i;
for (const block of blocks) {
  const inspect = value => {
    if (typeof value === 'string') assert(!suspicious.test(value), `${block.id}: suspicious binding/value ${value}`);
    else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
  };
  inspect(block.config);
}
const p27 = blocks.find(b => b.panelId === 'panel-27');
assert(p27);
assert(p27.config.periodBindingWarning);
assert.strictEqual(periodBindingWarning(p27.config.label, 'daily_solar'), p27.config.periodBindingWarning);
console.log('dashboard-template-binding-audit: PASS');
