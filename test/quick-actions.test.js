'use strict';
const checks = require('./_checks');
// Quick actions card (public/js/components/quickActions.js): which items are used, and that the card is wired
// into the server's list of Controls page types, the builders, the editor and the live-state updater.
// The card itself was checked in a browser (showcase page).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const { quickItems, MAX_QUICK_ACTIONS } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/quickActions.js')).href);

  assert.equal(MAX_QUICK_ACTIONS, 6);
  assert.deepEqual(quickItems({}), []);
  assert.deepEqual(quickItems({ items: 'x' }), []);
  assert.deepEqual(quickItems({ items: [null, 5, {}, { name: 'no entity' }] }), [], 'items with nothing to control are skipped');
  const ten = Array.from({ length: 10 }, (_, i) => ({ entity: 'switch.s' + i }));
  assert.equal(quickItems({ items: ten }).length, 6, 'at most six');
  assert.deepEqual(quickItems({ items: [{ entity: 'a' }, { name: 'skip' }, { entity: 'b' }] }).map(i => i.entity), ['a', 'b']);
  console.log('ok - items');

  const { CONTROL_TYPES } = require('../modules/dashboard-config');
  assert.ok(CONTROL_TYPES.has('quick-actions'), 'the server accepts it on the Controls page layout');
  const index = read('public/js/components/index.js');
  assert.match(index, /'quick-actions': buildControlPlaceholder/); assert.match(index, /'quick-actions': buildQuickActions/);
  assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('quick-actions'\)/);
  assert.match(read('public/js/editor-catalog.js'), /'quick-actions':\s+\{ group: 'controls', name: 'Quick actions'/);
  const ed = read('public/js/editor.js');
  assert.match(ed, /case 'quick-actions':\s+html \+= buildQuickActionsForm\(block\)/);
  assert.match(ed, /case 'quick-actions': \{/, 'it has a save case');
  assert.match(ed, /BLOCK_BUILDERS\.set\('quick-actions'/, 'the editor preview cannot be tapped');
  assert.match(read('private/js/showcase-layout.js'), /type: 'quick-actions'/);
  console.log('ok - wired in');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
