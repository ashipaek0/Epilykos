'use strict';
const checks = require('./_checks');
// The Device card: its options, the status and bar maths, and that it is wired into the registry, the data refresh, the
// editor (library, form, save), the showcase and the stylesheet. (Its drawing is checked in a browser.)
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/deviceCard.js')).href);

  // Every part is optional: an empty config is valid and draws nothing but the card.
  const e = D.deviceOptions({});
  assert.deepEqual([e.title, e.metric, e.showBar, e.statuses.length, e.stats.length, e.rows.length], ['', '', false, 0, 0, 0]);

  const o = D.deviceOptions({
    title: ' Inverter ', subtitle: 'AC output', icon: 'mdi:flash', metric: ' consumption ', decimals: '1', showBar: 'true', min: 0, max: 0, lowAt: '20', warnAt: '10',
    statuses: [{ metric: 'grid_status', when: 'on', text: 'Grid', color: '#22c55e' }, { metric: '', text: '' }, { metric: '', text: 'Off grid', color: 'red' }],
    stats: Array.from({ length: 6 }, (_, i) => ({ label: 'S' + i, metric: 'm' + i })).concat([{ label: 'no metric' }]),
    rows: Array.from({ length: 9 }, (_, i) => ({ label: 'R' + i, metric: 'r' + i, color: i ? '' : '#ff0000', signed: i === 1 })),
    extras: [{ metric: 'a' }, { metric: 'b' }, { metric: 'c' }, { metric: 'd' }]
  });
  assert.equal(o.title, 'Inverter'); assert.equal(o.metric, 'consumption'); assert.equal(o.decimals, 1);
  assert.equal(o.showBar, true); assert.ok(o.max > o.min, 'a bar always has a range');
  assert.equal(o.warnAt, 20, 'amber is never below red');
  assert.equal(o.statuses.length, 2, 'a status needs words'); assert.equal(o.statuses[1].color, '', 'a bad colour is dropped');
  assert.equal(o.stats.length, 3, 'at most three small readings'); assert.equal(o.rows.length, 6, 'at most six rows');
  assert.equal(o.rows[0].color, '#ff0000'); assert.equal(o.rows[1].signed, true); assert.equal(o.extras.length, 3);
  assert.equal(D.deviceOptions({ stats: [{ label: 'x' }] }).stats.length, 0, 'a reading needs a metric');

  // The status: the first true rule wins; a rule with no metric is the fallback.
  const on = { grid_status: { value: 1 } }, off = { grid_status: { value: 0 } };
  assert.equal(D.activeStatus(o, on).text, 'Grid');
  assert.equal(D.activeStatus(o, off).text, 'Off grid');
  assert.equal(D.activeStatus(o, {}).text, 'Off grid', 'no reading: the fallback');
  assert.equal(D.activeStatus(D.deviceOptions({ statuses: [{ metric: 'x', text: 'T' }] }), {}), null, 'nothing true, no fallback: no pill');

  // The bar.
  assert.equal(D.barFill(50, 0, 100), 0.5); assert.equal(D.barFill(150, 0, 100), 1); assert.equal(D.barFill(-5, 0, 100), 0);
  assert.equal(D.barFill('x', 0, 100), null); assert.equal(D.barFill(undefined, 0, 100), null);

  // Wiring.
  assert.match(read('public/js/components/index.js'), /'device-card': buildDeviceCard/);
  assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('device-card'\)\) updateDeviceCard/);
  assert.match(read('public/js/editor-catalog.js'), /'device-card':\s+\{ group: 'values'/);
  const ed = read('public/js/editor.js');
  assert.match(ed, /case 'device-card':\s+html \+= buildDeviceCardForm/);
  assert.match(ed, /case 'device-card': \{\s+var rowsOf/, 'the editor saves it');
  assert.match(ed, /renderRowList\(body, DEVICE_STATUS_SPEC\)/);
  assert.match(read('private/js/showcase-layout.js'), /type: 'device-card'/);
  assert.match(read('private/js/showcase.js'), /'device-card':/);
  assert.match(read('public/cards.css'), /\.device-card \{/);
  // No innerHTML with a setting in it: the picture goes through tileIcon, words through textContent.
  assert.doesNotMatch(read('public/js/components/deviceCard.js'), /innerHTML/);
  checks.done();
})().catch(err => { console.error(err); process.exit(1); });
