'use strict';
const checks = require('./_checks');
/**
 * Settings → Sources: the "Filter mappings" box of each source. A row matched on its textContent, which holds every
 * option of every dropdown (each row's metric list names every metric, a Modbus row's register list every register), so
 * any metric name matched every row, and none of what is typed in a field. rowSearchText reads what the row shows: the
 * chosen option of each dropdown, the typed text of each field and its own labels. Also: every source with mapping rows
 * has a filter box wired to its list.
 */
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'public', 'js', 'settings-shell.js'), 'utf8');

// The two functions as they are in settings-shell.js.
const start = shell.indexOf('  function rowSearchText(row) {');
const end = shell.indexOf('  window.stRowSearchText');
assert.ok(start > 0 && end > start, 'rowSearchText and filterRows are in settings-shell.js');
const ctx = {};
vm.runInNewContext(shell.slice(start, end) + '\nthis.rowSearchText = rowSearchText; this.filterRows = filterRows;', ctx);

// A tiny DOM: enough for the walk (nodeType, tagName, children, value, selectedOptions, style).
function el(tag, props = {}, kids = []) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), style: {}, ...props, kids };
  kids.forEach((k, i) => { k.nextSibling = kids[i + 1] || null; });
  node.firstChild = kids[0] || null;
  return node;
}
const text = t => ({ nodeType: 3, nodeValue: t });
const option = (value, label, selected) => el('option', { value, selected }, [text(label || value)]);
function select(chosen, values) {
  const opts = [option('', '-- Select metric --'), ...values.map(v => option(v, v, v === chosen))];
  return el('select', { selectedOptions: opts.filter(o => o.selected) }, opts);
}
const METRICS = ['battery_soc', 'grid_power', 'pv_power', 'load_power'];
function row(metric, register, typed) {
  const r = el('div', { className: 'metric-row' }, [
    select(metric, METRICS),
    select(String(register), ['30073', '32016', '32017']),
    el('input', { type: 'text', value: typed }),
    el('input', { type: 'checkbox', value: 'on' }),
    el('span', {}, [text('Register label')]),
    el('button', {}, [text('✕')]),
  ]);
  return r;
}

const r1 = row('grid_power', 32016, 'sensor.grid');
const t = ctx.rowSearchText(r1);
assert.ok(t.includes('grid_power') && t.includes('32016') && t.includes('sensor.grid') && t.includes('register label'), t);
assert.ok(!t.includes('pv_power') && !t.includes('battery_soc') && !t.includes('30073'), 'options that are not chosen are not searched: ' + t);
assert.ok(!t.includes('select metric'), 'nor the empty choice');
assert.ok(!/\bon\b/.test(t), 'nor a checkbox value');

const rows = [row('grid_power', 32016, 'a'), row('pv_power', 30073, 'b'), row('', 32017, 'typed here')];
const list = { querySelectorAll: () => rows };
const shown = q => { ctx.filterRows(list, q); return rows.filter(r => r.style.display !== 'none').length; };
assert.strictEqual(shown('pv_power'), 1, 'a metric name finds its row only (it used to find every row)');
assert.strictEqual(shown('30073'), 1, 'a register finds its row only');
assert.strictEqual(shown('typed'), 1, 'typed text is searched');
assert.strictEqual(shown('PV power'), 1, 'every word, any case');
assert.strictEqual(shown('zzz'), 0);
assert.strictEqual(shown(''), 3, 'an empty filter shows every row');
assert.strictEqual(shown('   '), 3);

// Wiring: one handler for every filter box; every source with mapping rows has one, pointing at its list.
assert.match(shell, /var input = e\.target\.closest\('\.mappings-filter-input'\);[\s\S]{0,200}filterRows\(list, input\.value\)/);
assert.ok(!/row\.textContent\.toLowerCase\(\)\.indexOf\(q\)/.test(shell.slice(shell.indexOf('Per-device mapping filters'), shell.indexOf('Per-device mapping filters') + 600)), 'textContent is no longer used for the mapping filters');
const settingsJs = fs.readFileSync(path.join(root, 'public', 'settings.js'), 'utf8');
for (const kind of ['ha', 'mqtt', 'modbus', 'rs232', 'external', 'dongle', 'tuya']) {
  assert.ok(settingsJs.includes(`class="mappings-filter-input"`) && new RegExp(`data-container="${kind}-mappings-list-\\$\\{idx\\}"`).test(settingsJs), `${kind}: a filter box for its mappings`);
  assert.ok(new RegExp(`id="${kind}-mappings-list-\\$\\{idx\\}"`).test(settingsJs), `${kind}: the list it filters`);
}
console.log('ok - settings mapping filters');
checks.done();
