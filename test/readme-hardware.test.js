'use strict';
// The README's Supported hardware table is generated from the profile files. This fails when a
// profile is added, renamed or changes status without re-running scripts/gen-readme-hardware.js.
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { render, apply } = require('../scripts/gen-readme-hardware');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
assert.equal(apply(readme), readme, 'README.md hardware table is out of date. Run: node scripts/gen-readme-hardware.js');

const table = render();
assert.match(table, /### Inverters and charge controllers/);
assert.match(table, /### Wired battery BMS/);
assert.match(table, /Unverified/, 'unverified profiles are flagged');
assert.ok(!/PLACEHOLDER/i.test(table), 'placeholder skeletons are not listed');

// every shipped, non-placeholder profile appears in the table
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : []));
let listed = 0;
for (const f of walk(path.join(__dirname, '..', 'profiles'))) {
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (p.placeholder === true) continue;
  assert.ok(table.includes(p.name.replaceAll('|', '\\|')), `${p.name} is missing from the README table`);
  listed++;
}
assert.ok(listed >= 30, `expected the table to list every profile, found ${listed}`);

// the markers must survive, exactly once
assert.equal(readme.split('<!-- hardware:start -->').length, 2);
assert.equal(readme.split('<!-- hardware:end -->').length, 2);

checks.done();
