'use strict';
const checks = require('./_checks');
// Fetching a source's entities lists the ones that are not mapped yet and
// leaves mapped rows alone. It used to empty the list first, so every metric
// the user had mapped (a LuxPower Bluetooth source, say) was unset at once.
// Runs the real catalog-ui.js on a small stand-in for the page.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../public/js/catalog-ui.js'), 'utf8');

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.className = ''; this.children = []; this.parent = null;
    this.dataset = {}; this.style = {}; this.listeners = {}; this.value = ''; this._text = '';
  }
  get classList() {
    const el = this;
    return { contains: c => el.className.split(/\s+/).includes(c), add: c => { if (!this.contains(c)) el.className = (el.className + ' ' + c).trim(); }, remove: c => { el.className = el.className.split(/\s+/).filter(x => x !== c).join(' '); } };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  set innerHTML(v) { this.children.forEach(c => { c.parent = null; }); this.children = []; this._html = v; }
  get innerHTML() { return this._html || ''; }
  appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter(x => x !== c); c.parent = this; this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
  setAttribute() {} focus() {}
  matches(sel) { return sel.startsWith('.') ? this.classList.contains(sel.slice(1)) : this.tagName === sel.toUpperCase(); }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel) {
    const parts = sel.split(/\s+/), last = parts[parts.length - 1], out = [];
    const walk = e => e.children.forEach(c => { if (c.matches(last)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const document = {
  createElement: tag => new El(tag), addEventListener() {}, dispatchEvent() {},
  querySelectorAll: () => [],
};
const select = (selected) => {   // the metric dropdown settings.js builds
  const s = new El('select'); s.className = 'metric-name'; s.value = selected || ''; return s;
};
const window = { fetch: async () => ({ ok: true }), createMetricDropdown: select };
const ctx = { window, document, CustomEvent: class {}, setTimeout, Promise, Array, Object, Set, String, JSON };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const CatalogUI = window.CatalogUI;
assert.ok(CatalogUI && typeof CatalogUI.fetchAndRender === 'function');

const entities = ['0010', '0011', '0012'].map(id => ({ id }));
const adapter = { entityId: e => e.id, entityLabel: e => 'Entity ' + e.id, fetch: async () => entities };
const card = new El('div'); card.className = 'device-card';
const list = new El('div'); list.className = 'mappings-list'; card.appendChild(list);
const handles = () => list.querySelectorAll('.metric-row').map(r => r.dataset.address);
const metricOf = r => r.querySelector('.metric-name').value;

(async () => {
  // A saved mapping, as restored on page load.
  list.appendChild(CatalogUI.createRow(adapter, { metricName: 'battery_voltage', handle: '0011', entity: entities[1], entities, mode: 'chip' }));
  await CatalogUI.fetchAndRender(adapter, list, null, {});
  assert.deepEqual(handles().sort(), ['0010', '0011', '0012'], 'every entity is listed once');
  const mapped = list.querySelectorAll('.metric-row').find(r => r.dataset.address === '0011');
  assert.equal(metricOf(mapped), 'battery_voltage', 'the mapped row keeps its metric');
  assert.equal(list.querySelectorAll('.metric-row').filter(r => metricOf(r)).length, 1, 'the others start empty');
  console.log('ok - a fetch keeps mapped rows and adds the rest');

  // Again, and with a metric picked on a fetched row in between.
  const fresh = list.querySelectorAll('.metric-row').find(r => r.dataset.address === '0010');
  fresh.querySelector('.metric-name').value = 'battery_current'; fresh.dataset.prevMetric = 'battery_current';
  await CatalogUI.fetchAndRender(adapter, list, null, {});
  assert.deepEqual(handles().sort(), ['0010', '0011', '0012'], 'no duplicates after a second fetch');
  assert.deepEqual(list.querySelectorAll('.metric-row').filter(r => metricOf(r)).map(r => metricOf(r)).sort(), ['battery_current', 'battery_voltage']);
  console.log('ok - fetching again changes nothing the user mapped');

  // A mapping the user just cleared still waits for the save-time warning.
  const cleared = list.querySelectorAll('.metric-row').find(r => r.dataset.address === '0011');
  cleared.querySelector('.metric-name').value = ''; cleared.dataset.cleared = '1';
  await CatalogUI.fetchAndRender(adapter, list, null, {});
  assert.equal(list.querySelectorAll('.metric-row').filter(r => r.dataset.cleared === '1').length, 1, 'the pending removal is not dropped');
  console.log('ok - a just-cleared mapping keeps its removal warning');

  // A failed fetch leaves the mappings in place, with the reason above them.
  const broken = { ...adapter, fetch: async () => { throw new Error('dongle unreachable'); } };
  const kept = () => list.querySelectorAll('.metric-row').filter(r => metricOf(r) || r.dataset.cleared === '1').map(r => r.dataset.address).sort();
  const before = kept();
  assert.equal(before.length, 2);
  await CatalogUI.fetchAndRender(broken, list, null, {});
  assert.deepEqual(kept(), before, 'a failed fetch removes no mapping');
  assert.equal(list.children[0].textContent, 'dongle unreachable');
  console.log('ok - a failed fetch keeps the mappings and says why');

  // Nothing mapped and nothing to list: the usual empty note.
  const empty = new El('div'); empty.className = 'mappings-list'; new El('div').appendChild(empty);
  await CatalogUI.fetchAndRender({ ...adapter, fetch: async () => [] }, empty, null, {});
  assert.equal(empty.children.length, 1);
  console.log('ok - an empty source still says so');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
