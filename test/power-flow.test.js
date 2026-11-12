'use strict';
const checks = require('./_checks');
// The Power flow card: sources on the left (Solar always; Battery, Grid and Generator only while active), destinations
// on the right (Home always; Battery and Grid export when they apply), joined by lines that follow the node slots.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const P = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/components/powerFlow.js')).href);
  const opts = P.powerFlowOptions({});
  const keys = list => list.map(n => n.key);
  const both = { battery: true, generator: true };
  const model = (w, o = opts, present = both) => P.powerFlowModel(w, o, present);

  // options
  assert.deepStrictEqual(opts.metrics, P.DEFAULT_METRICS);
  assert.ok(opts.showGridSource && opts.showGenerator && opts.showBatterySource && opts.showGridExport, 'all on by default');
  const off = P.powerFlowOptions({ showGenerator: false, showGridSource: false, metrics: { solar: ' pv ', generator: 7, grid_import: '' } });
  assert.strictEqual(off.showGenerator, false);
  assert.strictEqual(off.showGridSource, false);
  assert.strictEqual(off.metrics.solar, 'pv', 'a metric name is trimmed');
  assert.strictEqual(off.metrics.generator, 'generator', 'a non-text name falls back');
  assert.strictEqual(off.metrics.grid_import, 'grid_import', 'an empty name falls back');
  assert.deepStrictEqual(P.powerFlowOptions(undefined).metrics, P.DEFAULT_METRICS);

  // day: solar charges the battery and feeds the house, surplus is exported
  let m = model({ solar: 4000, consumption: 800, battery_charge: 2000, battery_discharge: 0, grid_export: 1200, battery_soc: 54 });
  assert.deepStrictEqual(keys(m.sources), ['src-solar']);
  assert.deepStrictEqual(keys(m.dests), ['dst-home', 'dst-battery', 'dst-grid']);
  assert.strictEqual(m.dests[1].soc, 54);
  assert.strictEqual(m.dests[2].w, 1200);
  // night: battery and grid feed the house, solar is idle but stays
  m = model({ solar: 0, consumption: 1500, battery_discharge: 800, grid_import: 700, battery_soc: 30 });
  assert.deepStrictEqual(keys(m.sources), ['src-solar', 'src-battery', 'src-grid']);
  assert.deepStrictEqual(keys(m.dests), ['dst-home'], 'a discharging battery is a source, not also a destination');
  assert.strictEqual(m.sources[0].flowing, false, 'idle solar is not flowing');
  assert.strictEqual(m.sources[1].soc, 30);
  // generator
  m = model({ solar: 0, consumption: 2000, generator: 2000 });
  assert.deepStrictEqual(keys(m.sources), ['src-solar', 'src-generator']);
  m = model({ solar: 0, consumption: 100, generator: 5 });
  assert.deepStrictEqual(keys(m.sources), ['src-solar'], 'a generator input idling at a few watts is off');
  // everything at once keeps the fixed order
  m = model({ solar: 500, consumption: 1500, battery_discharge: 800, grid_import: 600, generator: 2000 });
  assert.deepStrictEqual(keys(m.sources), ['src-solar', 'src-battery', 'src-grid', 'src-generator']);
  // idle: just solar and home, plus an idle battery
  m = model({ solar: 0, consumption: 0, battery_charge: 0, battery_discharge: 0 });
  assert.deepStrictEqual(keys(m.sources), ['src-solar']);
  assert.deepStrictEqual(keys(m.dests), ['dst-home', 'dst-battery']);
  assert.ok(m.sources.concat(m.dests).every(n => !n.flowing));

  // options hide nodes
  const w = { solar: 500, consumption: 1500, battery_discharge: 800, grid_import: 600, generator: 2000, grid_export: 0 };
  assert.ok(!keys(model(w, P.powerFlowOptions({ showGridSource: false })).sources).includes('src-grid'));
  assert.ok(!keys(model(w, P.powerFlowOptions({ showGenerator: false })).sources).includes('src-generator'));
  const noBatSrc = model(w, P.powerFlowOptions({ showBatterySource: false }));
  assert.ok(!keys(noBatSrc.sources).includes('src-battery'));
  assert.ok(keys(noBatSrc.dests).includes('dst-battery'), 'with the battery source off it stays on the right');
  assert.ok(!keys(model({ solar: 3000, consumption: 500, grid_export: 2000 }, P.powerFlowOptions({ showGridExport: false })).dests).includes('dst-grid'));

  // absent metrics and odd values
  m = model({ solar: 100, consumption: 100, battery_discharge: 800, generator: 2000 }, opts, {});
  assert.deepStrictEqual(keys(m.sources), ['src-solar'], 'no battery or generator metric, none shown');
  assert.deepStrictEqual(keys(m.dests), ['dst-home']);
  m = model({ solar: 'n/a', consumption: undefined, grid_import: null });
  assert.strictEqual(m.sources[0].w, 0);
  assert.strictEqual(m.dests[0].w, 0);
  m = model({ solar: -50, consumption: -5 });
  assert.strictEqual(m.sources[0].w, 0, 'negative solar shows as zero');
  m = model({ battery_discharge: 800, battery_soc: 'x' });
  assert.strictEqual(m.sources[1].soc, null, 'an unreadable charge level shows nothing');

  // lines
  for (const [s, d] of [[1, 1], [2, 1], [4, 3], [3, 2]]) {
    const p = P.flowPaths(s, d);
    assert.strictEqual(p.src.length, s);
    assert.strictEqual(p.dst.length, d);
  }
  assert.strictEqual(P.flowPaths(1, 1).src[0], 'M0 50 C32 50 36 50 50 50', 'a single source starts at the middle');
  assert.ok(P.flowPaths(2, 1).src[0].startsWith('M0 25 '), 'two slots centre at 25% and 75%');
  assert.ok(P.flowPaths(2, 1).src[1].startsWith('M0 75 '));
  assert.ok(P.flowPaths(1, 4).dst[3].endsWith('100 87.5'));
  assert.deepStrictEqual(P.flowPaths(0, 0), { src: [], dst: [] });

  // wiring
  assert.ok(/'power-flow': buildPowerFlow/.test(read('public/js/components/index.js')), 'registered');
  assert.ok(/updatePowerFlow\(state\)/.test(read('public/js/cards-update.js')) && /blockTypes\.has\('power-flow'\)/.test(read('public/js/cards-update.js')), 'refreshed with the data');
  const cat = read('public/js/editor-catalog.js');
  assert.ok(/'power-flow'/.test(cat) && /Power flow/.test(cat), 'in the library');
  const ed = read('public/js/editor.js');
  for (const id of ['modal-pf-title', 'modal-pf-grid', 'modal-pf-generator', 'modal-pf-battery', 'modal-pf-export']) assert.ok(ed.includes(id), id + ' in the editor');
  assert.ok(/case 'power-flow'/.test(ed));
  const show = read('private/js/showcase.js');
  assert.ok(/'power-flow'/.test(show) && /showGenerator/.test(show), 'showcase options');
  assert.ok(/type: 'power-flow'/.test(read('private/js/showcase-layout.js')), 'showcase card');
  const css = read('public/cards.css');
  const pf = css.slice(css.indexOf('Power flow'));
  assert.ok(/\.power-flow-card\s*\{[^}]*container-type:\s*size/.test(pf), 'the card is a size container');
  assert.ok(/--pf-font:[^;]*cqh/.test(pf) && /--pf-font:[^;]*cqw/.test(pf), 'text follows the card height and width');
  assert.ok(/\.pf-node\[hidden\]/.test(pf) || /\[hidden\]/.test(pf), 'hidden nodes stay hidden');
  assert.ok(/prefers-reduced-motion/.test(pf), 'the motion respects reduced-motion');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
